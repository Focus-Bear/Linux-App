import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enPack from './en.json' assert {type: 'json'};

const enLang = JSON.parse(enPack);

i18n.use(initReactI18next).init({
    en: enLang
})


export default i18n;