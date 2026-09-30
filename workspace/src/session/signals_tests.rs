use super::*;

#[test]
fn osc_777_notify_is_detected() {
    let mut s = OscScanner::default();
    assert_eq!(
        s.scan(b"x\x1b]777;notify;Claude Code;needs permission\x07y"),
        vec![Notice::Attention]
    );
}

#[test]
fn osc_split_across_chunks_is_detected() {
    let mut s = OscScanner::default();
    assert!(s.scan(b"\x1b]777;noti").is_empty());
    assert_eq!(s.scan(b"fy;t;b\x1b\\"), vec![Notice::Attention]);
}

#[test]
fn osc_9_message_is_attention_but_progress_is_not() {
    let mut s = OscScanner::default();
    assert_eq!(
        s.scan(b"\x1b]9;Codex needs you\x07"),
        vec![Notice::Attention]
    );
    assert!(s.scan(b"\x1b]9;4;1;50\x07").is_empty());
}

#[test]
fn title_osc_is_not_attention() {
    let mut s = OscScanner::default();
    assert!(s.scan(b"\x1b]0;hello\x07").is_empty());
}

#[test]
fn claude_title_with_star_is_idle() {
    assert_eq!(
        classify_title("\u{2733} Claude Code"),
        Some(TitleKind::Idle)
    );
}

#[test]
fn claude_title_with_spinner_is_working() {
    assert_eq!(
        classify_title("\u{2736} Writing tests"),
        Some(TitleKind::Working)
    );
    assert_eq!(
        classify_title("\u{280b} Thinking"),
        Some(TitleKind::Working)
    );
}

#[test]
fn unrelated_title_is_not_classified() {
    assert_eq!(classify_title("zsh"), None);
}
