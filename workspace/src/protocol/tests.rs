use super::*;

#[test]
fn frames_round_trip_through_a_buffer() {
    let mut buf = Vec::new();
    write_frame(&mut buf, b"hello").unwrap_or_else(|e| panic!("{e}"));
    let mut cursor = std::io::Cursor::new(buf);
    assert_eq!(read_frame(&mut cursor).ok().as_deref(), Some(&b"hello"[..]));
}

#[test]
fn oversized_frame_header_is_rejected() {
    let len = u32::try_from(MAX_FRAME + 1).unwrap_or(u32::MAX);
    let mut cursor = std::io::Cursor::new(len.to_le_bytes().to_vec());
    assert!(matches!(
        read_frame(&mut cursor),
        Err(ProtocolError::FrameTooLarge(_))
    ));
}

/// Bytes da camada de controle v1. NÃO mudar: qualquer Lisa futura precisa ler isto.
#[test]
fn hello_reply_v1_bytes_stay_decodable() {
    let frozen: [u8; 11] = [1, 3, b'0', b'.', b'1', 3, b'a', b'b', b'c', 2, 1];
    let reply: HelloReply = postcard::from_bytes(&frozen).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        reply,
        HelloReply {
            protocol_version: 1,
            binary_version: "0.1".into(),
            build_id: "abc".into(),
            live_agents: 2,
            accepted: true,
        }
    );
}

#[test]
fn shutdown_request_v1_bytes_stay_decodable() {
    let frozen: [u8; 2] = [0, 1];
    let req: ControlRequest = postcard::from_bytes(&frozen).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(req, ControlRequest::Shutdown { stop_agents: true });
}

#[test]
fn hello_v1_bytes_stay_decodable() {
    let frozen: [u8; 14] = [
        b'L', b'I', b'S', b'A', 1, 3, b'0', b'.', b'1', 3, b'a', b'b', b'c', 1,
    ];
    let hello: Hello = postcard::from_bytes(&frozen).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(hello.magic, MAGIC);
    assert_eq!(hello.client_kind, ClientKind::Hook);
}
