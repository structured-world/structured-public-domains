# GitHub Copilot Instructions for structured-public-domains

## Project Overview

Compact Public Suffix List (PSL) implementation for Rust. ~35KB embedded JSON trie compressed with zstd. O(depth) lookup. Checked daily against publicsuffix.org.

## Review Scope Rules

**Review ONLY code within the PR's diff.** For issues found outside the diff, suggest creating a separate issue.

## Rust Code Standards

- **No `unwrap()` or `expect()`** on any code path: `#[deny(clippy::unwrap_used, clippy::expect_used)]` enforced
- **Clippy:** Must pass `cargo clippy --all-features -- -D warnings`
- PSL data is auto-generated — do NOT manually edit `src/psl.json.zst` or generated data files
