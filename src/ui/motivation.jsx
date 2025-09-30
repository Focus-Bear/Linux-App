import { useTranslation } from "react-i18next";

const MotivationPage = function(){
    const { t } = useTranslation();
    return(
        <div>
            <h2>{t('CantImplement')}</h2>
        </div>
    )
}


export default MotivationPage;