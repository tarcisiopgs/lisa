//! Protocolo UI ↔ daemon: frames `u32` LE + payload postcard.
//!
//! Duas camadas. A de **controle** (`Hello`, `HelloReply`, `ControlRequest`) é
//! congelada para sempre: qualquer Lisa futura precisa conseguir falar com, e
//! encerrar, qualquer daemon antigo. A de **trabalho** (`ClientMsg`,
//! `DaemonMsg`) evolui com `PROTOCOL_VERSION`.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;

use serde::{Deserialize, Serialize};

pub mod work;

pub use work::{ClientMsg, DaemonMsg};

pub const MAGIC: [u8; 4] = *b"LISA";
/// Versão das mensagens de trabalho. A camada de controle não muda com ela.
pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

/// Primeiro byte de cada frame depois do handshake.
const CHANNEL_CONTROL: u8 = 0;
const CHANNEL_WORK: u8 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("frame of {0} bytes exceeds the limit")]
    FrameTooLarge(usize),
    #[error("peer is not a Lisa workspace endpoint")]
    BadMagic,
    #[error("unexpected frame")]
    Unexpected,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Decode(#[from] postcard::Error),
}

// ---- Camada de controle (congelada: não reordenar nem mudar tipos) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientKind {
    Ui,
    Hook,
    Cli,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub magic: [u8; 4],
    pub protocol_version: u32,
    pub binary_version: String,
    pub build_id: String,
    pub client_kind: ClientKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloReply {
    pub protocol_version: u32,
    pub binary_version: String,
    pub build_id: String,
    pub live_agents: u32,
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlRequest {
    /// Encerra o daemon; com `stop_agents`, encerra os agentes antes.
    Shutdown { stop_agents: bool },
}

// ---- Frames ----

pub fn write_frame(w: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

pub fn read_frame(r: &mut impl Read) -> Result<Vec<u8>, ProtocolError> {
    let mut header = [0u8; 4];
    r.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header) as usize;
    if len > MAX_FRAME {
        return Err(ProtocolError::FrameTooLarge(len));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(payload)
}

/// O que o daemon recebe de um cliente depois do handshake.
#[derive(Debug)]
pub enum ClientIncoming {
    Control(ControlRequest),
    Work(ClientMsg),
}

/// Uma conexão já enquadrada.
#[derive(Debug)]
pub struct Conn {
    stream: UnixStream,
}

impl Conn {
    pub fn new(stream: UnixStream) -> Self {
        Conn { stream }
    }

    pub fn into_stream(self) -> UnixStream {
        self.stream
    }

    pub fn try_clone(&self) -> io::Result<Conn> {
        Ok(Conn {
            stream: self.stream.try_clone()?,
        })
    }

    pub fn shutdown(&self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }

    fn send_raw(&mut self, bytes: &[u8]) -> Result<(), ProtocolError> {
        Ok(write_frame(&mut self.stream, bytes)?)
    }

    fn send_channel<T: Serialize>(&mut self, channel: u8, msg: &T) -> Result<(), ProtocolError> {
        let mut bytes = vec![channel];
        bytes.extend(postcard::to_stdvec(msg)?);
        self.send_raw(&bytes)
    }

    pub fn send_hello(&mut self, hello: &Hello) -> Result<(), ProtocolError> {
        let bytes = postcard::to_stdvec(hello)?;
        self.send_raw(&bytes)
    }

    pub fn recv_hello(&mut self) -> Result<Hello, ProtocolError> {
        let bytes = read_frame(&mut self.stream)?;
        if bytes.get(..4) != Some(&MAGIC[..]) {
            return Err(ProtocolError::BadMagic);
        }
        Ok(postcard::from_bytes(&bytes)?)
    }

    pub fn send_hello_reply(&mut self, reply: &HelloReply) -> Result<(), ProtocolError> {
        let bytes = postcard::to_stdvec(reply)?;
        self.send_raw(&bytes)
    }

    pub fn recv_hello_reply(&mut self) -> Result<HelloReply, ProtocolError> {
        let bytes = read_frame(&mut self.stream)?;
        Ok(postcard::from_bytes(&bytes)?)
    }

    pub fn send_control(&mut self, req: &ControlRequest) -> Result<(), ProtocolError> {
        self.send_channel(CHANNEL_CONTROL, req)
    }

    /// Cliente → daemon.
    pub fn send(&mut self, msg: &ClientMsg) -> Result<(), ProtocolError> {
        self.send_channel(CHANNEL_WORK, msg)
    }

    /// Daemon → cliente.
    pub fn send_daemon(&mut self, msg: &DaemonMsg) -> Result<(), ProtocolError> {
        self.send_channel(CHANNEL_WORK, msg)
    }

    pub fn recv_client(&mut self) -> Result<ClientIncoming, ProtocolError> {
        let bytes = read_frame(&mut self.stream)?;
        match bytes.split_first() {
            Some((&CHANNEL_CONTROL, body)) => {
                Ok(ClientIncoming::Control(postcard::from_bytes(body)?))
            }
            Some((&CHANNEL_WORK, body)) => Ok(ClientIncoming::Work(postcard::from_bytes(body)?)),
            _ => Err(ProtocolError::Unexpected),
        }
    }

    pub fn recv_daemon(&mut self) -> Result<DaemonMsg, ProtocolError> {
        let bytes = read_frame(&mut self.stream)?;
        match bytes.split_first() {
            Some((&CHANNEL_WORK, body)) => Ok(postcard::from_bytes(body)?),
            _ => Err(ProtocolError::Unexpected),
        }
    }
}

#[cfg(test)]
mod tests;
