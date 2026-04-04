# GitHub Copilot Instructions for structured-public-domains

## Project Overview

Compact Public Suffix List (PSL) implementation for Rust. Zero dependencies, ~108KB embedded binary trie. O(depth * log k) lookup. Checked daily against publicsuffix.org.

## Review Scope Rules

**Review ONLY code within the PR's diff.** For issues found outside the diff, suggest creating a separate issue.

## Rust Code Standards

- **No `unwrap()` or `expect()`** on any code path: `#[deny(clippy::unwrap_used, clippy::expect_used)]` enforced
- **Clippy:** Must pass `cargo clippy --all-features -- -D warnings`
- PSL data is auto-generated — do NOT manually edit `src/psl.bin` or generated data files
