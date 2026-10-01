use serde_json::json;

use super::*;
use crate::agents::{AgentId, Effort};

fn answers(probs: [f32; 4], size_confidence: f32, depth: f32, kind: Kind, kc: f32) -> Answers {
    Answers {
        size_probs: probs,
        size_confidence,
        depth,
        kind,
        kind_confidence: kc,
    }
}

const ALL: [AgentId; 3] = [AgentId::Claude, AgentId::Codex, AgentId::Gemini];
const COMPLEX: [f32; 4] = [0.0, 0.1, 0.8, 0.1];

/// Resposta real do Jev (jev-1.13.0) para uma tarefa de investigação.
fn documented() -> serde_json::Value {
    json!({
        "model": "jev-1.13.0",
        "answers": {
            "depth": { "type": "noul", "noul": 0.82 },
            "kind": {
                "type": "choice", "choice": "investigation", "confidence": 0.93,
                "probabilities": { "visual_ui": 0.0, "review": 0.0, "investigation": 0.95, "other": 0.05 }
            },
            "size": {
                "type": "score", "score": 2.78, "confidence": 0.78,
                "legend": { "0": "a", "1": "b", "2": "c", "3": "d" },
                "probabilities": { "0": 0.0, "1": 0.0, "2": 0.22, "3": 0.78 }
            }
        },
        "usage": { "input_tokens": 611, "output_tokens": 81 }
    })
}

#[test]
fn request_carries_the_task_and_three_questions() {
    let body = request_body("fix login");
    assert_eq!(body["state"], "fix login");
    assert_eq!(body["model"], "jev-latest");
    assert_eq!(body["questions"]["size"]["type"], "score");
    assert_eq!(
        body["questions"]["size"]["criteria"]
            .as_array()
            .map(Vec::len),
        Some(4)
    );
    assert_eq!(body["questions"]["depth"]["type"], "noul");
    assert_eq!(body["questions"]["kind"]["type"], "choice");
    for kind in ["visual_ui", "review", "investigation", "other"] {
        assert!(
            body["questions"]["kind"]["criteria"][kind].is_string(),
            "{kind}"
        );
    }
}

#[test]
fn parses_a_documented_response() {
    let a = parse_answers(&documented()).unwrap_or_else(|| panic!("not parsed"));
    assert_eq!(a.size_probs, [0.0, 0.0, 0.22, 0.78]);
    assert_eq!(a.size_confidence, 0.78);
    assert_eq!(a.depth, 0.82);
    assert_eq!(a.kind, Kind::Investigation);
    assert_eq!(a.kind_confidence, 0.93);
}

#[test]
fn malformed_responses_are_none() {
    assert_eq!(parse_answers(&json!({})), None);
    let mut unknown_kind = documented();
    unknown_kind["answers"]["kind"]["choice"] = json!("poetry");
    assert_eq!(parse_answers(&unknown_kind), None);
    let mut three_levels = documented();
    three_levels["answers"]["size"]["probabilities"] = json!({ "0": 0.5, "1": 0.3, "2": 0.2 });
    assert_eq!(parse_answers(&three_levels), None);
    let mut no_depth = documented();
    no_depth["answers"]["depth"] = json!({ "type": "noul" });
    assert_eq!(parse_answers(&no_depth), None);
    let mut out_of_range = documented();
    out_of_range["answers"]["depth"]["noul"] = json!(7.5);
    assert_eq!(parse_answers(&out_of_range), None);
}

#[test]
fn confident_kind_picks_its_harness() {
    let d = decide(
        &answers(COMPLEX, 0.7, 0.2, Kind::Review, 0.9),
        &ALL,
        &RouterConfig::default(),
    );
    assert_eq!(d.agent, Some(AgentId::Codex));
    assert_eq!(d.size, Size::Complex);
    assert!(!d.bump);
    assert!(!d.unsure);
    assert_eq!(d.percent, 70);
}

#[test]
fn other_kind_uses_the_preference_order() {
    let d = decide(
        &answers(COMPLEX, 0.7, 0.2, Kind::Other, 0.9),
        &ALL,
        &RouterConfig::default(),
    );
    assert_eq!((d.agent, d.unsure), (Some(AgentId::Claude), false));
}

#[test]
fn low_kind_confidence_is_unsure_and_uses_the_preference_order() {
    let d = decide(
        &answers(COMPLEX, 0.7, 0.2, Kind::Review, 0.3),
        &ALL,
        &RouterConfig::default(),
    );
    assert_eq!(
        (d.agent, d.unsure, d.percent),
        (Some(AgentId::Claude), true, 30)
    );
}

#[test]
fn mapped_harness_missing_falls_back_to_preference() {
    let d = decide(
        &answers(COMPLEX, 0.7, 0.2, Kind::Review, 0.9),
        &[AgentId::Claude, AgentId::Gemini],
        &RouterConfig::default(),
    );
    assert_eq!(d.agent, Some(AgentId::Claude));
}

#[test]
fn preference_skips_agents_that_are_not_usable() {
    let d = decide(
        &answers(COMPLEX, 0.7, 0.2, Kind::Other, 0.9),
        &[AgentId::Gemini],
        &RouterConfig::default(),
    );
    assert_eq!(d.agent, Some(AgentId::Gemini));
}

#[test]
fn nobody_usable_gives_no_agent() {
    let d = decide(
        &answers(COMPLEX, 0.7, 0.2, Kind::Review, 0.9),
        &[],
        &RouterConfig::default(),
    );
    assert_eq!(d.agent, None);
}

#[test]
fn uncertain_size_takes_the_larger_of_the_top_two() {
    let d = decide(
        &answers([0.05, 0.45, 0.40, 0.10], 0.2, 0.0, Kind::Other, 0.9),
        &ALL,
        &RouterConfig::default(),
    );
    assert_eq!(d.size, Size::Complex);
    let sure = decide(
        &answers([0.05, 0.45, 0.40, 0.10], 0.9, 0.0, Kind::Other, 0.9),
        &ALL,
        &RouterConfig::default(),
    );
    assert_eq!(sure.size, Size::Scoped);
}

#[test]
fn depth_at_the_threshold_does_not_bump() {
    let cfg = RouterConfig::default();
    assert!(!decide(&answers(COMPLEX, 0.7, 0.7, Kind::Other, 0.9), &ALL, &cfg).bump);
    assert!(decide(&answers(COMPLEX, 0.7, 0.71, Kind::Other, 0.9), &ALL, &cfg).bump);
}

#[test]
fn selection_follows_the_spec_table() {
    assert_eq!(
        selection(AgentId::Claude, Size::Trivial, false),
        Some(("haiku", None))
    );
    assert_eq!(
        selection(AgentId::Claude, Size::Scoped, false),
        Some(("sonnet", Some(Effort::Medium)))
    );
    assert_eq!(
        selection(AgentId::Claude, Size::Complex, false),
        Some(("opus", Some(Effort::Medium)))
    );
    assert_eq!(
        selection(AgentId::Claude, Size::Open, false),
        Some(("fable", Some(Effort::High)))
    );
    assert_eq!(
        selection(AgentId::Codex, Size::Trivial, false),
        Some(("gpt-6-luna", Some(Effort::Low)))
    );
    assert_eq!(
        selection(AgentId::Codex, Size::Scoped, false),
        Some(("gpt-6-luna", Some(Effort::High)))
    );
    assert_eq!(
        selection(AgentId::Codex, Size::Complex, false),
        Some(("gpt-6.1-sol", Some(Effort::Medium)))
    );
    assert_eq!(
        selection(AgentId::Codex, Size::Open, false),
        Some(("gpt-6-astra", Some(Effort::Low)))
    );
    assert_eq!(
        selection(AgentId::Gemini, Size::Trivial, false),
        Some(("flash-lite", None))
    );
    assert_eq!(
        selection(AgentId::Gemini, Size::Scoped, false),
        Some(("flash", None))
    );
    assert_eq!(
        selection(AgentId::Gemini, Size::Open, true),
        Some(("pro", None))
    );
    assert_eq!(selection(AgentId::Opencode, Size::Complex, false), None);
}

#[test]
fn bump_raises_one_level_and_never_suggests_max_or_ultra() {
    assert_eq!(
        selection(AgentId::Claude, Size::Complex, true),
        Some(("opus", Some(Effort::High)))
    );
    assert_eq!(
        selection(AgentId::Claude, Size::Open, true),
        Some(("fable", Some(Effort::Xhigh)))
    );
    assert_eq!(
        selection(AgentId::Claude, Size::Trivial, true),
        Some(("haiku", None))
    );
    assert_eq!(
        bumped(Effort::Xhigh, &[Effort::High, Effort::Xhigh, Effort::Max]),
        Effort::Xhigh
    );
    assert_eq!(
        bumped(Effort::High, &[Effort::Low, Effort::High, Effort::Max]),
        Effort::High
    );
    assert_eq!(
        bumped(Effort::Low, &[Effort::Low, Effort::High]),
        Effort::High
    );
}

#[test]
fn every_route_error_explains_itself() {
    for e in [
        RouteError::NoKey,
        RouteError::Unauthorized,
        RouteError::RateLimited,
        RouteError::Overloaded,
        RouteError::Timeout,
        RouteError::Network,
        RouteError::BadResponse,
    ] {
        assert!(e.reason().ends_with(" · choosing manually"), "{e:?}");
    }
    assert_eq!(
        RouteError::NoKey.reason(),
        "no TYPESAFE_API_KEY · choosing manually"
    );
}
