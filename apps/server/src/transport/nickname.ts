export const NICKNAME_MAX_CODE_POINTS = 12;

export const NicknameRejection = Object.freeze({
  Required: "NICKNAME_REQUIRED",
  TooLong: "NICKNAME_TOO_LONG",
  UnsupportedCharacters: "NICKNAME_UNSUPPORTED_CHARACTERS",
} as const);

export type NicknameValidationResult =
  | { readonly ok: true; readonly nickname: string }
  | {
      readonly ok: false;
      readonly error: (typeof NicknameRejection)[keyof typeof NicknameRejection];
      readonly message: string;
    };

/**
 * Product "characters" are Unicode code points, not UTF-16 code units.
 * Nicknames contain only Han characters, ASCII English letters, and ASCII digits.
 */
export function validateNickname(input: unknown): NicknameValidationResult {
  if (typeof input !== "string") {
    return Object.freeze({
      ok: false,
      error: NicknameRejection.Required,
      message: "Nickname is required",
    });
  }
  const nickname = input.trim();
  if (nickname.length === 0) {
    return Object.freeze({
      ok: false,
      error: NicknameRejection.Required,
      message: "Nickname is required",
    });
  }
  if (Array.from(nickname).length > NICKNAME_MAX_CODE_POINTS) {
    return Object.freeze({
      ok: false,
      error: NicknameRejection.TooLong,
      message: `Nickname must contain at most ${NICKNAME_MAX_CODE_POINTS} Unicode code points`,
    });
  }
  if (!/^[\p{Script=Han}A-Za-z0-9]+$/u.test(nickname)) {
    return Object.freeze({
      ok: false,
      error: NicknameRejection.UnsupportedCharacters,
      message: "Nickname may contain only Chinese characters, English letters, and digits",
    });
  }
  return Object.freeze({ ok: true, nickname });
}
