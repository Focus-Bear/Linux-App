import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import resources from './language_packs/_resources.js'


i18n.use(initReactI18next).init({
    
    resources,
    // Language to be used if language pack is invalid
    fallbackLng : 'en',
    // Sets the current language to be used. Will eventually be made dynamic
    lng: 'it'
})


export default i18n;