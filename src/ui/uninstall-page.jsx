import { useState, useEffect } from 'react';
import './styles/uninstall-page.css';

const UninstallPage = function() {
  const [copiedCommand, setCopiedCommand] = useState(null);
  const [distro, setDistro] = useState('unknown');
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState(null);

  useEffect(() => {
    detectDistro();
  }, []);

  const detectDistro = async function() {
    try {
      if (window.api?.detectDistro) {
        const detected = await window.api.detectDistro();
        setDistro(detected);
      }
    } catch (error) {
      console.error('Failed to detect distro:', error);
    }
  };

  const copyToClipboard = function(text, commandId) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedCommand(commandId);
      setTimeout(() => setCopiedCommand(null), 2000);
    });
  };

  const handleCleanup = async function() {
    setIsCleaningUp(true);
    setCleanupResult(null);

    try {
      if (window.api?.cleanupAppData) {
        const result = await window.api.cleanupAppData();
        setCleanupResult(result);
      }
    } catch (error) {
      console.error('Cleanup failed:', error);
      setCleanupResult({
        success: false,
        message: 'Failed to clean up app data: ' + error.message
      });
    } finally {
      setIsCleaningUp(false);
    }
  };

  const getUninstallCommand = function() {
    switch(distro) {
      case 'ubuntu':
      case 'debian':
      case 'mint':
        return 'sudo apt remove focusbear';
      case 'fedora':
        return 'sudo dnf remove focusbear';
      case 'arch':
        return 'rm ~/focusbear-*.AppImage';
      default:
        return 'Check your package manager to uninstall focusbear';
    }
  };

  const CodeBlock = function({ command, commandId }) {
    return (
      <div className="code-block-wrapper">
        <code className="code-block">{command}</code>
        <button
          type="button"
          className="fb-btn fb-btn--small"
          onClick={() => copyToClipboard(command, commandId)}
        >
          {copiedCommand === commandId ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    );
  };

  return (
    <section id="uninstall-page" className="fb-page">
      <h1 className="fb-page__title">Uninstall Focus Bear</h1>
      <p className="fb-page__subtitle">
        Before you uninstall, you can clean up all app data and settings. This removes your
        configuration but doesn&apos;t uninstall the application itself.
      </p>

      {cleanupResult && (
        <div className={`cleanup-status ${cleanupResult.success ? 'success' : 'error'}`}>
          <div className="status-icon">
            {cleanupResult.success ? '✓' : '⚠'}
          </div>
          <div className="status-content">
            <h3 className="status-title">
              {cleanupResult.success ? 'Cleanup Successful' : 'Cleanup Failed'}
            </h3>
            <p className="status-message">
              {cleanupResult.message}
            </p>
            {cleanupResult.details && (
              <ul className="cleanup-details">
                {cleanupResult.details.map((detail, idx) => (
                  <li key={idx}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="fb-card">
        <h2 className="fb-card__title">Clean up app data</h2>

        <p>
          This will remove all local data created by Focus Bear, including:
        </p>

        <ul className="instruction-list">
          <li>Your blocked sites and keywords configuration</li>
          <li>Application settings and preferences</li>
          <li>Temporary files in <code>/tmp/focusbear-*</code></li>
          <li>Focus session state</li>
        </ul>

        <div>
          <button
            type="button"
            className="fb-btn fb-btn--danger"
            onClick={handleCleanup}
            disabled={isCleaningUp}
          >
            {isCleaningUp ? 'Cleaning up...' : 'Clean Up App Data'}
          </button>
        </div>
      </div>

      <div className="fb-card">
        <h2 className="fb-card__title">Uninstall the application</h2>

        <p>
          After cleaning up your data, you can uninstall Focus Bear using your system's package manager:
        </p>

        <div className="command-group">
          <p className="command-label">Uninstall command for your system ({distro}):</p>
          <CodeBlock
            command={getUninstallCommand()}
            commandId="uninstall-cmd"
          />
        </div>

        <p className="uninstall-hint">
          Run this command in your terminal to completely remove Focus Bear from your system.
        </p>
      </div>

  
    </section>
  );
};

export default UninstallPage;
