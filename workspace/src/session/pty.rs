//! PTY de um agente: uma thread leitora, uma escritora com fila limitada e uma
//! que espera o processo. Parar mata o grupo de processos inteiro.

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use rustix::process::{Pid, Signal, kill_process_group, test_kill_process_group};

/// Fila de escrita por PTY; cheia, o input é descartado em vez de travar o daemon.
const WRITE_QUEUE: usize = 256;
/// Quanto a saída espera a leitura terminar antes de ser avisada.
const DRAIN_GRACE: Duration = Duration::from_millis(500);

/// Como subir o processo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Ambiente completo do processo (vindo da UI); vazio herda o do daemon.
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: SyncSender<Vec<u8>>,
    pid: Option<Pid>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn other(err: impl std::fmt::Display) -> io::Error {
    io::Error::other(err.to_string())
}

impl Pty {
    pub fn spawn(
        launch: &Launch,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> io::Result<Pty> {
        let pair = native_pty_system()
            .openpty(size(launch.cols, launch.rows))
            .map_err(other)?;

        let mut cmd = CommandBuilder::new(&launch.program);
        cmd.args(&launch.args);
        cmd.cwd(&launch.cwd);
        if !launch.env.is_empty() {
            cmd.env_clear();
            for (k, v) in &launch.env {
                cmd.env(k, v);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Permite rodar o Claude Code aninhado, como os providers já fazem
        cmd.env_remove("CLAUDECODE");

        let mut child = pair.slave.spawn_command(cmd).map_err(other)?;
        drop(pair.slave);
        let pid = child
            .process_id()
            .and_then(|p| i32::try_from(p).ok())
            .and_then(Pid::from_raw);

        let mut reader = pair.master.try_clone_reader().map_err(other)?;
        // Fecha quando a leitura acaba: a saída só é avisada depois da última tela
        let (drained_tx, drained_rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            let _drained = drained_tx;
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(buf[..n].to_vec()),
                }
            }
        });

        let mut writer = pair.master.take_writer().map_err(other)?;
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE);
        thread::spawn(move || {
            for bytes in rx {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });

        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            // O processo pode sair antes de a leitura entregar o que ele escreveu por
            // último. Espera a leitura fechar, com prazo: um neto que herdou o terminal
            // pode mantê-lo aberto.
            let _ = drained_rx.recv_timeout(DRAIN_GRACE);
            on_exit(code);
        });

        Ok(Pty {
            master: Mutex::new(pair.master),
            writer: tx,
            pid,
        })
    }

    /// Enfileira input; `false` quando a fila está cheia ou o processo saiu.
    pub fn write(&self, bytes: Vec<u8>) -> bool {
        match self.writer.try_send(bytes) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let master = self.master.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = master.resize(size(cols, rows));
    }

    pub fn pid(&self) -> Option<i32> {
        self.pid.map(Pid::as_raw_nonzero).map(i32::from)
    }

    /// SIGHUP e SIGTERM no grupo; depois da carência, SIGKILL.
    pub fn stop(&self, grace: Duration) {
        let Some(pid) = self.pid else { return };
        let _ = kill_process_group(pid, Signal::HUP);
        let _ = kill_process_group(pid, Signal::TERM);
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if test_kill_process_group(pid).is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = kill_process_group(pid, Signal::KILL);
    }
}
