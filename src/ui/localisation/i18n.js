import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enPack from './language_packs/en.json';
import itPack from './language_packs/it.json';

// Anytime a new language pack is created, it must be added to _resources below.
const _resources = {
    en: enPack,
    it: itPack
}


i18n.use(initReactI18next).init({
    
    resources : _resources,
    // Sets the current language to be used. Will eventually be made dynamic
    lng: 'it'
})


export default i18n;