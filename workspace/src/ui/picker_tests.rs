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

// ---- Grupos ----

fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

/// `work/` do `tree`, mais `work/acme/` com dois repositórios e `other/tool` fora dela.
fn group_tree() -> TempDir {
    let tmp = tree();
    for dir in [
        "work/acme/acme-api/.git",
        "work/acme/acme-web/.git",
        "work/acme/drafts",
        "other/tool/.git",
    ] {
        mkdir(tmp.path(), dir);
    }
    tmp
}

fn select_name(p: &mut Picker, name: &str) {
    let at = names(p)
        .iter()
        .position(|n| n == name)
        .unwrap_or_else(|| panic!("no entry {name}"));
    while p.selected() < at {
        p.on_key(key(KeyCode::Down));
    }
    while p.selected() > at {
        p.on_key(key(KeyCode::Up));
    }
}

fn pick_mode(p: &mut Picker, name: &str) {
    p.on_key(ctrl('n'));
    type_text(p, name);
    assert_eq!(p.on_key(key(KeyCode::Enter)), Outcome::Stay);
}

#[test]
fn ctrl_g_on_a_folder_with_repositories_returns_a_group_named_after_it() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    select_name(&mut p, "acme");
    let acme = tmp.path().join("work/acme");
    assert_eq!(
        p.on_key(ctrl('g')),
        Outcome::Group {
            name: "acme".into(),
            paths: vec![
                acme.join("acme-api").display().to_string(),
                acme.join("acme-web").display().to_string(),
            ],
        }
    );
}

#[test]
fn ctrl_g_on_a_folder_without_repositories_explains_and_stays() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    select_name(&mut p, "docs");
    assert_eq!(p.on_key(ctrl('g')), Outcome::Stay);
    assert_eq!(p.problem(), Some("no repositories in this folder"));
    // A explicação some na tecla seguinte
    p.on_key(key(KeyCode::Down));
    assert_eq!(p.problem(), None);
}

#[test]
fn ctrl_g_on_a_repository_does_nothing() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    select_name(&mut p, "api");
    assert_eq!(p.on_key(ctrl('g')), Outcome::Stay);
    assert_eq!(p.problem(), None);
}

#[test]
fn ctrl_g_refuses_a_name_that_is_already_a_group() {
    let tmp = group_tree();
    let mut p = open(&tmp).with_groups(&["Acme".to_owned()]);
    select_name(&mut p, "acme");
    assert_eq!(p.on_key(ctrl('g')), Outcome::Stay);
    assert_eq!(p.problem(), Some("a group named acme already exists"));
}

#[test]
fn ctrl_n_asks_for_a_name_then_lets_space_mark_repositories() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    p.on_key(ctrl('n'));
    assert_eq!(
        *p.mode(),
        Mode::GroupName {
            name: String::new()
        }
    );
    type_text(&mut p, "Backend");
    p.on_key(key(KeyCode::Enter));
    select_name(&mut p, "api");
    p.on_key(key(KeyCode::Char(' ')));
    assert!(p.current().is_some_and(|e| p.is_marked(e)));
    assert_eq!(
        p.on_key(key(KeyCode::Enter)),
        Outcome::Group {
            name: "Backend".into(),
            paths: vec![tmp.path().join("work/api").display().to_string()],
        }
    );
}

#[test]
fn marks_survive_moving_between_folders() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    pick_mode(&mut p, "Mixed");
    select_name(&mut p, "web");
    p.on_key(key(KeyCode::Char(' ')));
    p.on_key(key(KeyCode::Left));
    select_name(&mut p, "other");
    p.on_key(key(KeyCode::Right));
    select_name(&mut p, "tool");
    p.on_key(key(KeyCode::Char(' ')));
    assert_eq!(
        p.on_key(key(KeyCode::Enter)),
        Outcome::Group {
            name: "Mixed".into(),
            paths: vec![
                tmp.path().join("work/web").display().to_string(),
                tmp.path().join("other/tool").display().to_string(),
            ],
        }
    );
}

#[test]
fn space_in_pick_mode_never_reaches_the_filter_and_unmarks_on_the_second_press() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    pick_mode(&mut p, "G");
    select_name(&mut p, "api");
    p.on_key(key(KeyCode::Char(' ')));
    p.on_key(key(KeyCode::Char(' ')));
    assert_eq!(p.query(), "");
    assert!(p.current().is_some_and(|e| !p.is_marked(e)));
    // Sobre uma pasta comum, a barra de espaço não marca nada
    select_name(&mut p, "docs");
    p.on_key(key(KeyCode::Char(' ')));
    assert_eq!(p.on_key(key(KeyCode::Enter)), Outcome::Stay);
}

#[test]
fn enter_without_marks_explains_and_stays() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    pick_mode(&mut p, "G");
    assert_eq!(p.on_key(key(KeyCode::Enter)), Outcome::Stay);
    assert_eq!(p.problem(), Some("mark at least one repository"));
}

#[test]
fn an_empty_or_taken_group_name_is_refused_inline() {
    let tmp = group_tree();
    let mut p = open(&tmp).with_groups(&["Acme".to_owned()]);
    p.on_key(ctrl('n'));
    type_text(&mut p, "  ");
    p.on_key(key(KeyCode::Enter));
    assert_eq!(p.problem(), Some("give the group a name"));
    type_text(&mut p, "ACME");
    p.on_key(key(KeyCode::Enter));
    assert_eq!(p.problem(), Some("a group named ACME already exists"));
    assert!(matches!(p.mode(), Mode::GroupName { .. }));
}

#[test]
fn a_mapped_repository_can_be_marked_for_a_group() {
    let tmp = group_tree();
    let mut p = Picker::open(
        &tmp.path().join("work"),
        Some(tmp.path().to_path_buf()),
        &[tmp.path().join("work/api")],
    );
    pick_mode(&mut p, "G");
    select_name(&mut p, "api");
    assert!(p.current().is_some_and(|e| e.added));
    p.on_key(key(KeyCode::Char(' ')));
    assert!(matches!(
        p.on_key(key(KeyCode::Enter)),
        Outcome::Group { paths, .. } if paths.len() == 1
    ));
}

#[test]
fn typing_still_filters_in_pick_mode() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    pick_mode(&mut p, "G");
    type_text(&mut p, "we");
    assert_eq!(names(&p), ["web"]);
}

#[test]
fn pasting_while_naming_a_group_goes_to_the_name() {
    let tmp = group_tree();
    let mut p = open(&tmp);
    p.on_key(ctrl('n'));
    p.paste("Backend\n");
    assert_eq!(
        *p.mode(),
        Mode::GroupName {
            name: "Backend".into()
        }
    );
}
