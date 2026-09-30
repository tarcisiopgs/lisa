//! Mede o RSS do daemon com N agentes e scrollback cheio a 200 colunas.
//! Uso: cargo run --release --example memory -- 3

use std::sync::mpsc;
use std::time::Duration;

use lisa_workspace::daemon::service::SCROLLBACK;
use lisa_workspace::session::SessionManager;
use lisa_workspace::session::pty::Launch;

fn main() {
    let agents: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(3);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || for _ in rx {});
    let manager = SessionManager::new(tx, SCROLLBACK);
    // Cada agente imprime linhas de 200 colunas coloridas até encher o scrollback, e fica vivo
    let script = format!(
        "i=0; while [ $i -lt {} ]; do printf '\\033[3%dm%0200d\\033[0m\\n' $((i % 7)) $i; i=$((i+1)); done; sleep 600",
        SCROLLBACK + 200
    );
    for n in 0..agents {
        let launch = Launch {
            program: "/bin/bash".into(),
            args: vec!["-c".into(), script.clone()],
            cwd: std::env::temp_dir(),
            env: Vec::new(),
            cols: 200,
            rows: 50,
        };
        if let Err(e) = manager.start(&format!("p{n}"), launch) {
            eprintln!("spawn failed: {e}");
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    while std::time::Instant::now() < deadline
        && (0..agents).any(|n| manager.history_len(&format!("p{n}")).unwrap_or(0) < SCROLLBACK)
    {
        std::thread::sleep(Duration::from_millis(200));
    }
    let filled: Vec<usize> = (0..agents)
        .filter_map(|n| manager.history_len(&format!("p{n}")))
        .collect();
    println!("history per agent: {filled:?}");
    let rss = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    println!("agents={agents} scrollback={SCROLLBACK} rss_kb={rss}");
    use lisa_workspace::daemon::SessionHost;
    manager.stop_all();
}
