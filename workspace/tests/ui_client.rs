//! UI dirigida por teclas contra um daemon real (F1–F4), sem terminal: o `App`
//! recebe teclas e mensagens do daemon e as ações dele são enviadas de verdade.

mod common;

use std::time::{Duration, Instant};

use common::*;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lisa_workspace::daemon::client::{Connector, Handshake};
use lisa_workspace::protocol::{ClientKind, Conn};
use lisa_workspace::ui::app::{Action, App, Row};

struct Ui {
    app: App,
    conn: Conn,
}

fn connect(env: &Env, c: &Connector) -> Ui {
    let conn = match c.connect(ClientKind::Ui) {
        Ok(Handshake::Attached { conn, .. }) => conn,
        other => panic!("attach failed: {:?}", other.map(|_| ())),
    };
    conn.set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap_or_else(|e| panic!("{e}"));
    let mut ui = Ui {
        app: App::new(110, 30),
        conn,
    };
    ui.app.on_focus(true);
    let env_vars = vec![
        (
            "SHELL".into(),
            env.bin.join("shells/bash").display().to_string(),
        ),
        (
            "PATH".into(),
            format!("{}:/usr/bin:/bin", env.bin.display()),
        ),
    ];
    let attach = ui.app.attach_msg(env_vars);
    ui.conn.send(&attach).unwrap_or_else(|e| panic!("{e}"));
    ui
}

impl Ui {
    fn run(&mut self, actions: Vec<Action>) {
        for a in actions {
            if let Action::Send(msg) = a {
                self.conn.send(&msg).unwrap_or_else(|e| panic!("{e}"));
            }
        }
    }

    fn key(&mut self, code: KeyCode) {
        let actions = self.app.on_key(KeyEvent::new(code, KeyModifiers::NONE));
        self.run(actions);
    }

    fn prefix(&mut self) {
        let actions = self
            .app
            .on_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
        self.run(actions);
    }

    fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            self.key(KeyCode::Char(c));
        }
    }

    /// Processa mensagens do daemon até `done` ou o prazo.
    fn pump(&mut self, what: &str, done: impl Fn(&App) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !done(&self.app) {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            if let Ok(msg) = self.conn.recv_daemon() {
                let actions = self.app.on_daemon(msg);
                self.run(actions);
            }
        }
    }

    fn screen_text(&self) -> String {
        self.app
            .screen()
            .map(|s| {
                s.lines
                    .iter()
                    .map(|l| l.cells.iter().map(|c| c.ch).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }

    fn select(&mut self, name: &str) {
        let idx = self.app.rows().iter().position(|r| {
            matches!(r, Row::Worktree { id } if self.app.worktree(id).is_some_and(|w| w.name == name))
        });
        self.app
            .select_row(idx.unwrap_or_else(|| panic!("no worktree {name}")));
    }

    fn add_project(&mut self, path: &str) {
        self.prefix();
        self.key(KeyCode::Char('p'));
        self.type_text(path);
        self.key(KeyCode::Enter);
        self.pump("project", |a| !a.workspace().projects.is_empty());
    }

    /// Cria um worktree sem tarefa e devolve o nome que o diálogo gerou para ele.
    fn new_worktree(&mut self) -> String {
        self.prefix();
        self.key(KeyCode::Char('n'));
        // Etapa da tarefa, em branco; depois a revisão, aceita como veio
        self.key(KeyCode::Enter);
        let name = match self.app.dialog() {
            Some(lisa_workspace::ui::app::Dialog::NewWorktree(d)) => d.name.clone(),
            other => panic!("no new worktree dialog: {other:?}"),
        };
        self.key(KeyCode::Enter);
        let n = name.clone();
        self.pump("worktree opened", move |a| {
            a.focused_view().is_some_and(|w| w.name == n)
        });
        name
    }
}

fn contains(ui: &mut Ui, needle: &str) {
    let n = needle.to_owned();
    ui.pump(needle, move |a| {
        a.screen().is_some_and(|s| {
            s.lines.iter().any(|l| {
                l.cells
                    .iter()
                    .map(|c| c.ch)
                    .collect::<String>()
                    .contains(&n)
            })
        })
    });
}

#[test]
fn adding_a_project_and_creating_a_worktree_opens_the_agent() {
    let env = setup();
    let c = start(&env);
    let mut ui = connect(&env, &c);
    ui.add_project(&env.repo.display().to_string());
    ui.new_worktree();
    contains(&mut ui, "fake-claude-ready");
    ui.type_text("hello");
    ui.key(KeyCode::Enter);
    contains(&mut ui, "echo:hello");
}

#[test]
fn switching_worktrees_swaps_the_pane_without_stopping_the_other_agent() {
    let env = setup();
    let c = start(&env);
    let mut ui = connect(&env, &c);
    ui.add_project(&env.repo.display().to_string());
    let first = ui.new_worktree();
    contains(&mut ui, "fake-claude-ready");
    ui.type_text("from-first");
    ui.key(KeyCode::Enter);
    contains(&mut ui, "echo:from-first");
    let second = ui.new_worktree();
    assert_ne!(first, second);
    contains(&mut ui, "fake-claude-ready");
    assert!(!ui.screen_text().contains("from-first"));
    ui.prefix();
    ui.select(&first);
    ui.key(KeyCode::Enter);
    contains(&mut ui, "echo:from-first");
    assert!(ui.app.workspace().worktrees.iter().all(|w| w.running));
}

#[test]
fn leaving_the_ui_keeps_agents_running_for_the_next_one() {
    let env = setup();
    let c = start(&env);
    let mut ui = connect(&env, &c);
    ui.add_project(&env.repo.display().to_string());
    let keep = ui.new_worktree();
    contains(&mut ui, "fake-claude-ready");
    drop(ui);
    let mut again = connect(&env, &c);
    again.pump("state", |a| !a.workspace().worktrees.is_empty());
    assert!(
        again
            .app
            .workspace()
            .worktrees
            .iter()
            .any(|w| w.name == keep && w.running)
    );
    again.prefix();
    again.select(&keep);
    again.key(KeyCode::Enter);
    contains(&mut again, "fake-claude-ready");
}

#[test]
fn removing_a_dirty_worktree_is_refused_and_it_stays_listed() {
    let env = setup();
    let c = start(&env);
    let mut ui = connect(&env, &c);
    ui.add_project(&env.repo.display().to_string());
    let dirty = ui.new_worktree();
    std::fs::write(
        env.root.join(format!("workspaces/repo/{dirty}/README")),
        "changed",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    ui.prefix();
    ui.select(&dirty);
    ui.key(KeyCode::Char('d'));
    ui.key(KeyCode::Char('y'));
    ui.pump("refusal", |a| {
        matches!(
            a.dialog(),
            Some(lisa_workspace::ui::app::Dialog::ConfirmRemove {
                refused: Some(_),
                ..
            })
        )
    });
    ui.key(KeyCode::Esc);
    assert!(
        ui.app
            .workspace()
            .worktrees
            .iter()
            .any(|w| w.name == dirty && w.running)
    );
}
