import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enPack from './en.json';
import itPack from './it.json';

console.log("test");



i18n.use(initReactI18next).init({
    resources : {
        en: enPack,
        it: itPack
    },
    lng: 'it'
})


export default i18n;