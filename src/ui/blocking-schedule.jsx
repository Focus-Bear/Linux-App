import './styles/blocking-schedule.css'
import { useState } from 'react';
import { useTranslation } from 'react-i18next';



const BlockingSchedule = function(){

    const [selectedBlockMode, setSelectedBlockMode] = useState('manual');
    const { t } = useTranslation();

    const handleChange = function(event) {
        //setSelectedFruit(e.target.value);
        
        setSelectedBlockMode(event.target.value)
        console.log(`event value ${selectedBlockMode}`)
        console.log(`use state ${selectedBlockMode}`)
    };


    return (
        <div id="bs-root">
            <hr id='bs-divide'/>
            <div id="blockmodes-root">

                <h3>{t('WhenDoYouWantToBlockSites')}</h3>
                <br />
                <div >
                    <input 
                    type="radio" 
                    name="block-mode" 
                    value="automatic" 
                    checked={selectedBlockMode === 'automatic'} 
                    onChange={handleChange} 
                    /> {t("AutomaticSchedule")}
                </div>
                <small>
                    {t('AutomaticScheduleDescription')}
                </small>
                <br />


                <div className='block-mode-radio'>
                    <input 
                    type="radio" 
                    name="block-mode" 
                    value="manual" 
                    checked={selectedBlockMode === 'manual'} 
                    onChange={handleChange} 
                    /> {t('ManualSchedule')}
                    
                </div>
                <small>{t('ManualScheduleDescription')}</small>
                <br />


                <div className='block-mode-radio'>
                    <input 
                    type="radio" 
                    name="block-mode" 
                    value="advanced" 
                    checked={selectedBlockMode === 'advanced'} 
                    onChange={handleChange} 
                    /> {t('AdvancedSchedule')}
                    
                </div>
                <small>{t('ComingSoon')}</small>
              


            </div>
        </div>
 
 



    )



}


export default BlockingSchedule;