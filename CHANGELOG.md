# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.5](https://github.com/structured-world/structured-public-domains/compare/v0.0.4...v0.0.5) - 2026-04-04

### Added

- smart PSL auto-update with domain diff, drop zstd references ([#21](https://github.com/structured-world/structured-public-domains/pull/21))
- compact binary trie — drop serde/serde_json, halve runtime memory ([#17](https://github.com/structured-world/structured-public-domains/pull/17))

## [0.0.2](https://github.com/structured-world/structured-public-domains/compare/v0.0.1...v0.0.2) - 2026-03-25

### Added

- PSL trie lookup — 35KB embedded, O(depth), checked daily ([#2](https://github.com/structured-world/structured-public-domains/pull/2))
