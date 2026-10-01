use super::*;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::fs;
use tempfile::TempDir;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn type_text(p: &mut Picker, text: &str) {
    for c in text.chars() {
        p.on_key(key(KeyCode::Char(c)));
    }
}

fn mkdir(root: &Path, rel: &str) {
    fs::create_dir_all(root.join(rel)).unwrap_or_else(|e| panic!("{e}"));
}

/// `work/` com dois repositórios, duas pastas comuns, uma oculta e um arquivo.
fn tree() -> TempDir {
    let tmp = TempDir::new().unwrap_or_else(|e| panic!("{e}"));
    for dir in [
        "work/web/.git",
        "work/api/.git",
        "work/docs/guide",
        "work/Zeta",
        "work/.config",
    ] {
        mkdir(tmp.path(), dir);
    }
    fs::write(tmp.path().join("work/notes.txt"), "x").unwrap_or_else(|e| panic!("{e}"));
    tmp
}

fn open(tmp: &TempDir) -> Picker {
    Picker::open(
        &tmp.path().join("work"),
        Some(tmp.path().to_path_buf()),
        &[],
    )
}

fn names(p: &Picker) -> Vec<String> {
    p.visible().iter().map(|e| e.name.clone()).collect()
}

#[test]
fn lists_folders_with_repositories_first() {
    let tmp = tree();
    let p = open(&tmp);
    assert_eq!(names(&p), ["api", "web", "docs", "Zeta"]);
    assert_eq!(
        p.visible().iter().map(|e| e.repo).collect::<Vec<_>>(),
        [true, true, false, false]
    );
}

#[test]
fn the_directory_is_shown_relative_to_home() {
    let tmp = tree();
    assert_eq!(open(&tmp).dir_label(), "~/work/");
}

#[test]
fn typing_filters_by_subsequence_ignoring_case() {
    let tmp = TempDir::new().unwrap_or_else(|e| panic!("{e}"));
    for dir in [
        "guru-astral-checkout-back",
        "guru-astral-landing-page",
        "glowz",
    ] {
        mkdir(tmp.path(), dir);
    }
    let mut p = Picker::open(tmp.path(), None, &[]);
    type_text(&mut p, "GCHK");
    assert_eq!(names(&p), ["guru-astral-checkout-back"]);
}

#[test]
fn closer_matches_come_first() {
    let tmp = TempDir::new().unwrap_or_else(|e| panic!("{e}"));
    for dir in ["a-p-i", "glowz-api", "api-gateway", "api"] {
        mkdir(tmp.path(), dir);
    }
    let mut p = Picker::open(tmp.path(), None, &[]);
    type_text(&mut p, "api");
    assert_eq!(names(&p), ["api", "api-gateway", "glowz-api", "a-p-i"]);
}

#[test]
fn hidden_folders_show_only_when_the_filter_starts_with_a_dot() {
    let tmp = tree();
    let mut p = open(&tmp);
    type_text(&mut p, ".c");
    assert_eq!(names(&p), [".config"]);
}

#[test]
fn arrows_move_the_selection_within_the_list() {
    let tmp = tree();
    let mut p = open(&tmp);
    p.on_key(key(KeyCode::Up));
    assert_eq!(p.selected(), 0);
    for _ in 0..9 {
        p.on_key(key(KeyCode::Down));
    }
    assert_eq!(p.selected(), 3);
}

#[test]
fn right_enters_the_folder_and_left_returns_to_it() {
    let tmp = tree();
    let mut p = open(&tmp);
    p.on_key(key(KeyCode::Down));
    p.on_key(key(KeyCode::Down));
    p.on_key(key(KeyCode::Right));
    assert_eq!(p.dir_label(), "~/work/docs/");
    assert_eq!(names(&p), ["guide"]);
    p.on_key(key(KeyCode::Left));
    assert_eq!(p.dir_label(), "~/work/");
    assert_eq!(p.current().map(|e| e.name.as_str()), Some("docs"));
}

#[test]
fn backspace_on_an_empty_filter_goes_up() {
    let tmp = tree();
    let mut p = open(&tmp);
    type_text(&mut p, "a");
    p.on_key(key(KeyCode::Backspace));
    assert_eq!(p.dir_label(), "~/work/");
    p.on_key(key(KeyCode::Backspace));
    assert_eq!(p.dir_label(), "~/");
}

#[test]
fn enter_on_a_repository_adds_its_absolute_path() {
    let tmp = tree();
    let mut p = open(&tmp);
    p.on_key(key(KeyCode::Down));
    assert_eq!(
        p.on_key(key(KeyCode::Enter)),
        Outcome::Add(tmp.path().join("work/web").display().to_string())
    );
}

#[test]
fn enter_on_a_plain_folder_opens_it() {
    let tmp = tree();
    let mut p = open(&tmp);
    type_text(&mut p, "doc");
    assert_eq!(p.on_key(key(KeyCode::Enter)), Outcome::Stay);
    assert_eq!(p.dir_label(), "~/work/docs/");
    assert_eq!(p.query(), "");
}

#[test]
fn a_mapped_repository_is_marked_and_cannot_be_added_again() {
    let tmp = tree();
    let mut p = Picker::open(
        &tmp.path().join("work"),
        None,
        &[tmp.path().join("work/api")],
    );
    assert!(p.current().is_some_and(|e| e.name == "api" && e.added));
    assert_eq!(p.on_key(key(KeyCode::Enter)), Outcome::Stay);
}

#[test]
fn a_typed_path_lists_that_folder_filtered_by_its_last_segment() {
    let tmp = tree();
    let mut p = Picker::open(tmp.path(), None, &[]);
    let typed = format!("{}/work/we", tmp.path().display());
    type_text(&mut p, &typed);
    assert_eq!(names(&p), ["web"]);
    assert_eq!(
        p.on_key(key(KeyCode::Enter)),
        Outcome::Add(tmp.path().join("work/web").display().to_string())
    );
}

#[test]
fn a_tilde_path_starts_from_home() {
    let tmp = tree();
    let mut p = Picker::open(&tmp.path().join("work/docs"), Some(tmp.path().into()), &[]);
    type_text(&mut p, "~/work/ap");
    assert_eq!(p.dir_label(), "~/work/");
    assert_eq!(names(&p), ["api"]);
}

#[test]
fn a_pasted_path_replaces_the_filter_and_selects_the_folder() {
    let tmp = tree();
    let mut p = open(&tmp);
    type_text(&mut p, "zzz");
    p.paste(&format!("{}/work/api/\n", tmp.path().display()));
    assert_eq!(p.current().map(|e| e.name.as_str()), Some("api"));
    assert_eq!(
        p.on_key(key(KeyCode::Enter)),
        Outcome::Add(tmp.path().join("work/api").display().to_string())
    );
}

#[test]
fn an_unreadable_folder_says_why_and_still_lets_you_go_up() {
    let tmp = tree();
    let mut p = open(&tmp);
    type_text(&mut p, &format!("{}/work/missing/", tmp.path().display()));
    assert_eq!(p.error(), Some("no such folder"));
    assert!(p.visible().is_empty());
    p.on_key(key(KeyCode::Left));
    assert_eq!(p.error(), None);
    assert_eq!(p.dir_label(), "~/work/");
}

#[test]
fn a_typed_path_that_matches_nothing_is_left_for_the_daemon_to_judge() {
    let tmp = tree();
    let mut p = Picker::open(tmp.path(), Some("/home/me".into()), &[]);
    type_text(&mut p, "~/code/app");
    assert_eq!(
        p.on_key(key(KeyCode::Enter)),
        Outcome::Add("/home/me/code/app".into())
    );
}

#[test]
fn enter_with_no_match_does_nothing() {
    let tmp = tree();
    let mut p = open(&tmp);
    type_text(&mut p, "zzz");
    assert_eq!(p.on_key(key(KeyCode::Enter)), Outcome::Stay);
    assert_eq!(p.query(), "zzz");
}

#[test]
fn the_total_counts_what_is_listed_without_a_filter() {
    let tmp = tree();
    let mut p = open(&tmp);
    type_text(&mut p, "api");
    assert_eq!(p.total(), 4);
}
