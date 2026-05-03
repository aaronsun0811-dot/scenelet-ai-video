
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { voidCall } from '@/utils/async';

import enCommon from './en/common';
import enAuth from './en/auth';
import enDashboard from './en/dashboard';
import enErrors from './en/errors';
import enTemplates from './en/templates';
import enAssets from './en/assets';

import zhCommon from './zh/common';
import zhAuth from './zh/auth';
import zhDashboard from './zh/dashboard';
import zhErrors from './zh/errors';
import zhTemplates from './zh/templates';
import zhAssets from './zh/assets';

import jaCommon from './ja/common';
import jaAuth from './ja/auth';
import jaDashboard from './ja/dashboard';
import jaErrors from './ja/errors';
import jaTemplates from './ja/templates';
import jaAssets from './ja/assets';

const resources = {
  en: {
    common: enCommon,
    auth: enAuth,
    dashboard: enDashboard,
    errors: enErrors,
    templates: enTemplates,
    assets: enAssets,
  },
  zh: {
    common: zhCommon,
    auth: zhAuth,
    dashboard: zhDashboard,
    errors: zhErrors,
    templates: zhTemplates,
    assets: zhAssets,
  },
  ja: {
    common: jaCommon,
    auth: jaAuth,
    dashboard: jaDashboard,
    errors: jaErrors,
    templates: jaTemplates,
    assets: jaAssets,
  },
};

voidCall(i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh',
    supportedLngs: ['zh', 'en', 'ja'],
    nonExplicitSupportedLngs: true,
    debug: false,
    interpolation: {
      escapeValue: false,
    },
    // Use 'common' as the default namespace
    defaultNS: 'common',
    ns: ['common', 'auth', 'dashboard', 'errors', 'templates', 'assets'],
  }));

export default i18n;
