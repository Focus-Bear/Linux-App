import React, { useState, useEffect } from 'react';
import './styles/Consistent-colors.css';
import './styles/distracting-sites.css';
import { useTranslation } from 'react-i18next';

const Keywords_page = function() {
  const [showModal, setShowModal] = useState(false);
  const [KwInput, setKwInput] = useState('');
  const [keywords, setKeywords] = useState('');
  const [selectedKeyword, setSelectedKeyword] = useState(new Set()); 
  const { t } = useTranslation();

  useEffect(function() {
    window.api?.printList(keywords);
    window.api?.exportKeywords?.(keywords); 
  }, [keywords]);

  const KwList = keywords.split('\n').filter(keyword => keyword.trim()); 

  const handleAddKw = function() {
    if (KwInput.trim()) {
      setKeywords(keywords + (keywords ? '\n' : '') + KwInput.trim());
      setKwInput('');
      setShowModal(false);
    }
  };

  const toggleKeywordSelection = function(index) {
    const newSelection = new Set(selectedKeyword);
    if (newSelection.has(index)) {
      newSelection.delete(index);
    } else {
      newSelection.add(index);
    }
    setSelectedKeyword(newSelection);
  };

  const handleRemoveKw = function() {
    const remainingKw = KwList.filter((_, index) => !selectedKeyword.has(index)); 
    setKeywords(remainingKw.join('\n')); 
    setSelectedKeyword(new Set());
  };

  const closeModal = function() {
    setShowModal(false);
    setKwInput('');
  };

  return (
    <section id="distracting-sites">
      <h1 style={{ fontSize: '1.1rem' }}>{t('DistractingKeywords')}</h1>
      <br />

      <p style={{ fontSize: '0.8rem' }}>
        {t('KeywordExplanation')}
      </p>

      <br /><br />

      <div className="url-list">
        {KwList.map((keyword, index) => (
          <div 
            key={index}
            className={`url-item ${selectedKeyword.has(index) ? 'selected' : ''}`} 
            onClick={() => toggleKeywordSelection(index)}
          >
            {keyword}
          </div>
        ))}
      </div>
      <br />

      <hr />
      <button id='url-button' className='ds-button' onClick={() => setShowModal(true)}>
        {t('AddKeyword')}
      </button>
      <button 
        id='remove-button' 
        className='ds-button' 
        onClick={handleRemoveKw}
        disabled={selectedKeyword.size === 0} 
      >
        {t('RemoveKey')} ({selectedKeyword.size})
      </button>

      {/* Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="url-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <img 
                src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJMMTMuMDkgOC4yNkwyMCA5TDEzLjA5IDE1Lc0MTQgMjJMMTAuOTEgMTUuNzRMNCA5TDEwLjkxIDguMjZMMTIgMloiIGZpbGw9IiNGRjk1MDAiLz4KPC9zdmc+Cg==" 
                alt="Focus Bear" 
                className="modal-icon" 
              />
              <span>{t('AddKeyword')}</span>
              <button className="close-btn" onClick={closeModal}>✕</button>
            </div>
            
            <div className="modal-body">
              <input
                type="text"
                value={KwInput}
                onChange={(e) => setKwInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddKw()}
                placeholder={t('GamesKey')}
                autoFocus
                className="url-input"
              />
              <div className="help-text">
                <div>{t('ToBlockSitesContainingAKeyword')}</div>
                <div>{t('ToBlockMultipleKeywords')}</div>
              </div>
            </div>
            
            <div className="modal-footer">
              <button className="cancel-btn" onClick={closeModal}>
                {t('CancelKey')}
              </button>
              <button className="add-btn" onClick={handleAddKw}>
                {t('AddKey')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default Keywords_page;