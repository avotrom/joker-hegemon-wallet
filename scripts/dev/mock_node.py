#!/usr/bin/env python3
"""DEV ONLY: fake Hegemon JSON-RPC node for exercising the UI with --mock builds."""
import json, time, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GENESIS = "0xd9a8cfc158790b0251c7493d7261da771f7d57be63bce750ba8c1af5d92a9ad3"
START, T0, SPEED = 1_150, time.time(), 20  # one block per 20 s


def height():
    return START + int((time.time() - T0) / SPEED)


def bhash(h):
    return GENESIS if h == 0 else "0x" + hashlib.sha256(f"blk{h}".encode()).hexdigest()


def handle(m, p):
    if m == "system_version": return "0.11.4-3fbf18f"
    if m == "rpc_methods": return {"methods": ["chain_getBlockHash", "hegemon_submitAction", "hegemon_latestBlock"]}
    if m == "hegemon_nodeConfig":
        return {"chainId": "0x7b7b0899d5444ffd92c38b38188e9ce4f891913ca7cca854fdcae0aa22ca1b49", "networkProfile": "pre-mainnet",
                "networkManifestDigest": "0x00", "rpcMethods": "public-submit", "redacted": True}
    if m == "chain_getBlockHash": return bhash(p[0]) if p[0] <= height() else None
    if m == "hegemon_latestBlock": return {"height": height(), "hash": bhash(height()), "timestamp": int((T0 + (height() - START) * SPEED) * 1000)}
    if m == "hegemon_consensusStatus": return {"height": height(), "peers": 7, "syncing": False}
    if m == "hegemon_privateSpendParameters": return {"relation_digest": "mock", "action_id": 15}
    if m == "hegemon_blockTimestamps":
        return [{"height": h, "timestamp_ms": int((T0 + (h - START) * SPEED) * 1000)} for h in range(p[0], p[1] + 1)]
    if m == "chain_getBlockActionsChunk":
        h = int(hashlib.sha256(p[0].encode()).hexdigest(), 16) % 3
        return {"schema": "hegemon.native.action-body-chunk-v1", "block_hash": p[0], "height": 0, "parent_hash": "0x", "tx_count": h,
                "extrinsics_root": "0x", "action_body_hash": "0x", "action_body_len": 1, "chunk_index": 0, "chunk_count": 1, "chunk_len": 1, "chunk": "0x00"}
    if m == "hegemon_submitAction": return {"success": True, "tx_hash": "0x" + "ab" * 48}
    raise KeyError(m)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        def one(r):
            try: return {"jsonrpc": "2.0", "id": r["id"], "result": handle(r["method"], r.get("params") or [])}
            except KeyError: return {"jsonrpc": "2.0", "id": r["id"], "error": {"code": -32601, "message": "method not found"}}
        out = [one(r) for r in req] if isinstance(req, list) else one(req)
        body = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", 9944), H).serve_forever()
