# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Storage**: Improved `getSignedUrl()` stub implementation to work without service account credentials
  - Generate deterministic signatures based on bucket, path, expiry, and action
  - Fix `X-Goog-Expires` to use duration in seconds instead of milliseconds timestamp
  - Add dynamic `X-Goog-Date` formatting in ISO 8601 basic format
  - Match Google Cloud Storage signed URL format with proper credential structure
  - Add comprehensive tests for deterministic behavior and different input variations

## [0.10.0] - 2026-01-28

### Added
- **Storage**: Add `getSignedUrl()` method to `IStorageFile` interface
- Support for generating signed URLs for Cloud Storage files
- `GetSignedUrlConfig` interface with support for read/write/delete/resumable actions
- Comprehensive unit and integration tests for signed URL generation

## [0.9.0] - (Previous release)

## [0.8.0] - (Previous release)

## [0.7.0] - (Previous release)

## [0.6.0] - (Previous release)

[Unreleased]: https://github.com/npomfret/ts-firebase-simulator/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/npomfret/ts-firebase-simulator/releases/tag/v0.10.0
