# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.12](https://github.com/structured-world/structured-public-domains/compare/v0.0.11...v0.0.12) - 2026-06-30

### Data

PSL data update: +0 -1 domains.

<details><summary>Removed (1)</summary>

```
zuev-cascade-probe.example
```

</details>


## [0.0.11](https://github.com/structured-world/structured-public-domains/compare/v0.0.10...v0.0.11) - 2026-06-29

### Data

PSL data update: +1 -0 domains.

<details><summary>Added (1)</summary>

```
zuev-cascade-probe.example
```

</details>


## [0.0.9](https://github.com/structured-world/structured-public-domains/compare/v0.0.8...v0.0.9) - 2026-06-28

### Added

- *(ci)* trigger downstream rebuild on PSL data release ([#38](https://github.com/structured-world/structured-public-domains/pull/38))

## [0.0.8](https://github.com/structured-world/structured-public-domains/compare/v0.0.7...v0.0.8) - 2026-06-26

### Added

- *(npm)* tiny build — runtime-fetched PSL with local cache ([#35](https://github.com/structured-world/structured-public-domains/pull/35))

## [0.0.6](https://github.com/structured-world/structured-public-domains/compare/v0.0.5...v0.0.6) - 2026-06-23

### Added

- wasm target + npm publish for Node.js/browser consumers ([#23](https://github.com/structured-world/structured-public-domains/pull/23))

## [0.0.5](https://github.com/structured-world/structured-public-domains/compare/v0.0.4...v0.0.5) - 2026-04-04

### Added

- smart PSL auto-update with domain diff, drop zstd references ([#21](https://github.com/structured-world/structured-public-domains/pull/21))
- compact binary trie — drop serde/serde_json, halve runtime memory ([#17](https://github.com/structured-world/structured-public-domains/pull/17))

## [0.0.2](https://github.com/structured-world/structured-public-domains/compare/v0.0.1...v0.0.2) - 2026-03-25

### Added

- PSL trie lookup — 35KB embedded, O(depth), checked daily ([#2](https://github.com/structured-world/structured-public-domains/pull/2))
