export const GUIDANCE: Readonly<Record<string, string>>;
export function readGuidance(runtime: string, id: unknown): { path: string; text: string };
export function validateGuidance(runtime: string): void;
export function withWorkGuidance(runtime: string, id: string, instruction: string): string;
