import type enAuth from "../en/auth";

export default {
  login: "ログイン",
  logging_in: "ログイン中...",
  login_failed: "ログインに失敗しました",
  register: "アカウント作成",
  registering: "作成中...",
  register_failed: "登録に失敗しました",
  show_register: "アカウントを作成",
  show_login: "ログインに戻る",
  username: "ユーザー名",
  password: "パスワード",
  confirm_password: "パスワード確認",
  password_mismatch: "パスワードが一致しません",
  password_min_length: "パスワードは8文字以上にしてください",
} satisfies Record<keyof typeof enAuth, string>;
