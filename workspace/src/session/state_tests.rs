use super::*;
use crate::protocol::work::AgentState::*;

fn tracker(rich: bool) -> Tracker {
    let mut t = Tracker::new(rich);
    t.on(Signal::Spawned);
    t
}

#[test]
fn spawning_starts_in_working() {
    assert_eq!(tracker(true).state(), Working);
}

#[test]
fn permission_prompt_moves_to_needs_you() {
    let mut t = tracker(true);
    assert_eq!(
        t.on(Signal::NeedsYou),
        Some(Transition {
            from: Working,
            to: NeedsYou
        })
    );
}

#[test]
fn stop_hook_moves_to_done() {
    let mut t = tracker(true);
    assert_eq!(t.on(Signal::Done).map(|x| x.to), Some(Done));
}

#[test]
fn output_after_user_input_returns_to_working_from_needs_you() {
    let mut t = tracker(true);
    t.on(Signal::NeedsYou);
    assert_eq!(t.on(Signal::Output), None);
    t.on(Signal::UserInput);
    assert_eq!(t.on(Signal::Output).map(|x| x.to), Some(Working));
}

#[test]
fn looking_at_a_done_worktree_moves_to_idle_without_exiting() {
    let mut t = tracker(true);
    t.on(Signal::Done);
    assert_eq!(t.on(Signal::Looked).map(|x| x.to), Some(Idle));
    assert!(t.running());
}

#[test]
fn output_after_input_on_an_idle_live_agent_returns_to_working() {
    let mut t = tracker(true);
    t.on(Signal::Done);
    t.on(Signal::Looked);
    t.on(Signal::UserInput);
    assert_eq!(t.on(Signal::Output).map(|x| x.to), Some(Working));
}

#[test]
fn exit_from_any_state_goes_to_idle_and_not_running() {
    for setup in [Signal::Spawned, Signal::NeedsYou, Signal::Done] {
        let mut t = tracker(true);
        t.on(setup);
        t.on(Signal::Exited);
        assert_eq!(t.state(), Idle);
        assert!(!t.running());
    }
}

#[test]
fn signals_after_exit_are_ignored_until_respawn() {
    let mut t = tracker(true);
    t.on(Signal::Exited);
    assert_eq!(t.on(Signal::NeedsYou), None);
    assert_eq!(t.on(Signal::Spawned).map(|x| x.to), Some(Working));
}

#[test]
fn silence_only_counts_for_agents_without_rich_signals() {
    let mut rich = tracker(true);
    assert_eq!(rich.on(Signal::Silence), None);
    let mut plain = tracker(false);
    assert_eq!(plain.on(Signal::Silence).map(|x| x.to), Some(Done));
}

#[test]
fn working_title_counts_as_activity_without_user_input() {
    let mut t = tracker(true);
    t.on(Signal::Done);
    assert_eq!(t.on(Signal::TitleWorking).map(|x| x.to), Some(Working));
}

#[test]
fn idle_title_moves_working_to_done() {
    let mut t = tracker(true);
    assert_eq!(t.on(Signal::TitleIdle).map(|x| x.to), Some(Done));
}
