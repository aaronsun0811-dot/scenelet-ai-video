import type enAuth from '../en/auth';

export default {
  'login': '登录',
  'logging_in': '登录中...',
  'login_failed': '登录失败',
  'register': '创建账号',
  'registering': '创建中...',
  'register_failed': '注册失败',
  'show_register': '创建账号',
  'show_login': '返回登录',
  'username': '用户名',
  'password': '密码',
  'confirm_password': '确认密码',
  'password_mismatch': '两次输入的密码不一致',
  'password_min_length': '密码至少需要 8 位',
} satisfies Record<keyof typeof enAuth, string>;
