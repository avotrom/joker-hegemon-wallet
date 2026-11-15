//! Native tests of the core's JSON operations against Hegemon's real wallet code.
use serde_json::{Value, json};

fn call(req: Value) -> Value {
    serde_json::from_str(&joker_core::run_json(&req.to_string())).unwrap()
}

fn ok(req: Value) -> Value {
    let r = call(req.clone());
    assert_eq!(r["ok"], true, "{req} -> {r}");
    r["result"].clone()
}

#[test]
fn wallet_lifecycle() {
    let _ = std::fs::remove_dir_all("joker-native-wallet");
    let entropy = "11".repeat(32);

    let v = ok(json!({"op": "version"}));
    assert!(v["relation_digest"].as_str().unwrap().len() >= 96, "{v}");

    assert_eq!(ok(json!({"op": "exists"}))["exists"], false);
    let short = call(json!({"op": "create", "passphrase": "short", "entropy": entropy}));
    assert_eq!(short["ok"], false);

    let created = ok(json!({"op": "create", "passphrase": "correct horse", "entropy": entropy}));
    let addr = created["address"].as_str().unwrap().to_string();
    assert!(addr.starts_with("shca1"), "{addr}");
    assert_eq!(ok(json!({"op": "exists"}))["exists"], true);

    // Same entropy, same address (restore from 24 words gives the same wallet).
    let again = ok(json!({"op": "address", "passphrase": "correct horse", "index": 0}));
    assert_eq!(again["address"], addr);

    let dup = call(json!({"op": "create", "passphrase": "correct horse", "entropy": entropy}));
    assert_eq!(dup["ok"], false);

    let wrong = call(json!({"op": "check", "passphrase": "wrong password"}));
    assert_eq!(wrong["ok"], false);
    assert!(wrong["error"].as_str().unwrap().contains("unlock failed"));

    assert_eq!(ok(json!({"op": "validate_address", "address": addr}))["valid"], true);
    assert_eq!(ok(json!({"op": "validate_address", "address": "shca1qqqq"}))["valid"], false);
    let mut flipped = addr.clone();
    let last = flipped.pop().unwrap();
    flipped.push(if last == 'q' { 'p' } else { 'q' });
    assert_eq!(ok(json!({"op": "validate_address", "address": flipped}))["valid"], false);

    let st = ok(json!({"op": "status", "passphrase": "correct horse"}));
    assert_eq!(st["initialized"], false);
    assert_eq!(st["balance"]["available"]["atoms"], "0");
    assert_eq!(st["notes"].as_array().unwrap().len(), 0);

    // kdf: deterministic per (password, salt), refuses a wrong password.
    let salt = "ab".repeat(16);
    let k1 = ok(json!({"op": "kdf", "passphrase": "correct horse", "salt": salt}));
    let k2 = ok(json!({"op": "kdf", "passphrase": "correct horse", "salt": salt}));
    let k3 = ok(json!({"op": "kdf", "passphrase": "correct horse", "salt": "cd".repeat(16)}));
    assert_eq!(k1["key"], k2["key"]);
    assert_ne!(k1["key"], k3["key"]);
    assert_eq!(k1["key"].as_str().unwrap().len(), 64);
    assert_eq!(call(json!({"op": "kdf", "passphrase": "wrong password", "salt": salt}))["ok"], false);

    ok(json!({"op": "change_passphrase", "passphrase": "correct horse", "new_passphrase": "battery staple 2"}));
    assert_eq!(call(json!({"op": "check", "passphrase": "correct horse"}))["ok"], false);
    let after = ok(json!({"op": "address", "passphrase": "battery staple 2", "index": 0}));
    assert_eq!(after["address"], addr, "keys survive the password change");

    ok(json!({"op": "rescan", "passphrase": "battery staple 2"}));
    assert_eq!(ok(json!({"op": "address", "passphrase": "battery staple 2"}))["address"], addr);

    let _ = std::fs::remove_dir_all("joker-native-wallet");
}
