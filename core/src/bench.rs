//! Development-only proving benchmark (feature `bench`).
use transaction_circuit::private_spend as spend;

/// Prove + verify the ordinary qualification fixture. Returns a JSON summary.
pub fn prove_fixture() -> String {
    let (public, witness) = spend::qualification::fixture(0);
    let out = match spend::prove_candidate(&public, &witness) {
        Ok(proof) => {
            let verified = spend::verify_candidate(&public, &proof).is_ok();
            serde_json::json!({ "ok": true, "proof_bytes": proof.len(), "verified": verified })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    out.to_string()
}
