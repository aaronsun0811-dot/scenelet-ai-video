import type enErrors from "../en/errors";

export default {
  unknown_error: "不明なエラーが発生しました",
  network_error: "ネットワークエラーです。接続を確認してください",
  unauthorized: "認証されていません。再度ログインしてください",
  forbidden: "アクセス権限がありません",
  not_found: "リソースが見つかりません",
  server_error: "サーバーエラーです。後でもう一度お試しください",
  validation_error: "入力内容の検証に失敗しました",
  source_unsupported_format: "対応していないソース形式です: {{ext}}",
  source_decode_failed: "「{{filename}}」のデコードに失敗しました（試行: {{tried}}）",
  source_corrupt_file: "ソースファイル「{{filename}}」を解析できません: {{reason}}",
  source_too_large: "ソースファイル「{{filename}}」が大きすぎます（{{size_mb}} MB > {{limit_mb}} MB）",
  source_conflict: "ソースファイル「{{existing}}」は既に存在します",
} satisfies Record<keyof typeof enErrors, string>;
