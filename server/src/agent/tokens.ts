// Ported from opencode — packages/core/src/util/token.ts
// Copyright (c) 2025 opencode — MIT License. See THIRD-PARTY-NOTICES.md

const CHARS_PER_TOKEN = 4

export const estimate = (input: string): number => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))
