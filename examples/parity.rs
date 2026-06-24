//! Parity harness: read domains from stdin, print `suffix|registrable|known`
//! (or `NONE`) per line. Paired with a JS twin to prove the TS port matches.
use std::io::{self, BufRead, Write};
use structured_public_domains::lookup;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(domain) = line else { break };
        match lookup(&domain) {
            Some(info) => {
                let reg = info.registrable_domain().unwrap_or("");
                let _ = writeln!(out, "{}|{}|{}", info.suffix(), reg, info.is_known());
            }
            None => {
                let _ = writeln!(out, "NONE");
            }
        }
    }
}
