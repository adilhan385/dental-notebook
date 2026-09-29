import React, { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Database, Plus, Check } from 'lucide-react';
import {
  formatDisplayDate,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch } from '../services/api';

interface Props {
  t: TranslationDict;
  clinic: any;
  account: any;
  servicesCatalog: any[];
  onClinicUpdated: (c: any) => void;
  onServicesUpdated: () => void;
}

export function SettingsView({
  t,
  clinic,
  account,
  servicesCatalog,
  onClinicUpdated,
  onServicesUpdated,
}: Props) {
  const [clinicName, setClinicName] = useState(clinic?.name || '');
  const [clinicPhone, setClinicPhone] = useState(clinic?.phone || '');
  const [clinicSubtitle, setClinicSubtitle] = useState(clinic?.subtitle || '');
  const [clinicSavedMsg, setClinicSavedMsg] = useState('');

  // New Service Form
  const [svcRu, setSvcRu] = useState('');
  const [svcKz, setSvcKz] = useState('');
  const [svcEn, setSvcEn] = useState('');
  const [svcPrice, setSvcPrice] = useState('');

  // Password Change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwStatus, setPwStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  // 2FA TOTP
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpEnabled, setTotpEnabled] = useState<boolean>(
    Boolean(account?.totpEnabled)
  );

  // Backups & Audit
  const [backupResult, setBackupResult] = useState<any | null>(null);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);

  const loadAuditLogs = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings/audit-logs');
      setAuditEvents(res.events || []);
    } catch {
      // handled
    }
  }, []);

  useEffect(() => {
    loadAuditLogs();
  }, [loadAuditLogs]);

  async function handleSaveClinic(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiFetch('/api/settings/clinic', {
      method: 'PATCH',
      body: {
        name: clinicName.trim(),
        phone: clinicPhone.trim() || null,
        subtitle: clinicSubtitle.trim() || null,
      },
    });
    onClinicUpdated(res.clinic);
    setClinicSavedMsg('Сохранено');
    setTimeout(() => setClinicSavedMsg(''), 2500);
  }

  async function handleAddService(e: React.FormEvent) {
    e.preventDefault();
    if (!svcRu.trim()) return;
    await apiFetch('/api/settings/services', {
      method: 'POST',
      body: {
        name_ru: svcRu.trim(),
        name_kz: svcKz.trim() || svcRu.trim(),
        name_en: svcEn.trim() || svcRu.trim(),
        reference_price: svcPrice ? Number(svcPrice) : null,
        active: true,
      },
    });
    setSvcRu('');
    setSvcKz('');
    setSvcEn('');
    setSvcPrice('');
    onServicesUpdated();
  }

  async function handleUpdateServicePrice(id: string, newPriceStr: string) {
    const num = newPriceStr === '' ? null : Number(newPriceStr);
    await apiFetch(`/api/settings/services/${id}`, {
      method: 'PATCH',
      body: { reference_price: num },
    });
    onServicesUpdated();
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwStatus(null);
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      setPwStatus({ type: 'ok', text: 'Пароль успешно обновлён.' });
      loadAuditLogs();
    } catch (err) {
      setPwStatus({
        type: 'err',
        text: err instanceof Error ? err.message : 'Ошибка смены пароля',
      });
    }
  }

  async function handleSetup2fa() {
    const res = await apiFetch('/api/auth/2fa/setup', { method: 'POST' });
    setTotpSecret(res.secret);
  }

  async function handleConfirmEnable2fa(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/api/auth/2fa/enable', {
      method: 'POST',
      body: { code: totpCode.trim() },
    });
    setTotpEnabled(true);
    setTotpSecret('');
    setTotpCode('');
    loadAuditLogs();
  }

  async function handleCreateBackup() {
    const res = await apiFetch('/api/settings/backup', { method: 'POST' });
    setBackupResult(res.backup);
    loadAuditLogs();
  }

  return (
    <div className="page-stack">
      <div className="card">
        <h1 style={{ margin: 0, fontSize: 22 }}>{t.settings.title}</h1>
      </div>

      {/* Clinic Basic Info */}
      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          {t.settings.clinicSection}
        </h2>
        <form onSubmit={handleSaveClinic} className="form-stack">
          <div className="form-row-3">
            <div className="form-group">
              <label>{t.settings.clinicName}</label>
              <input
                type="text"
                className="input"
                value={clinicName}
                onChange={(e) => setClinicName(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>{t.settings.clinicPhone}</label>
              <input
                type="text"
                className="input"
                value={clinicPhone}
                onChange={(e) => setClinicPhone(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>{t.settings.clinicSubtitle}</label>
              <input
                type="text"
                className="input"
                value={clinicSubtitle}
                onChange={(e) => setClinicSubtitle(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" className="btn btn-primary">
              {t.patients.saveBtn}
            </button>
            {clinicSavedMsg && (
              <span className="icon-inline" style={{ color: '#15803D', fontWeight: 600 }}>
                <Check size={16} />
                <span>{clinicSavedMsg}</span>
              </span>
            )}
          </div>
        </form>
      </div>

      {/* Standard Service Price Reference Catalog */}
      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          {t.settings.servicesSection}
        </h2>

        <form
          onSubmit={handleAddService}
          className="form-row-4"
          style={{ marginBottom: 18, alignItems: 'flex-end' }}
        >
          <div className="form-group">
            <label>{t.settings.serviceNameRu} *</label>
            <input
              type="text"
              className="input"
              value={svcRu}
              onChange={(e) => setSvcRu(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>{t.settings.serviceNameKz}</label>
            <input
              type="text"
              className="input"
              value={svcKz}
              onChange={(e) => setSvcKz(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t.settings.serviceNameEn}</label>
            <input
              type="text"
              className="input"
              value={svcEn}
              onChange={(e) => setSvcEn(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label>{t.settings.refPrice}</label>
              <input
                type="number"
                min={0}
                step={500}
                className="input"
                value={svcPrice}
                onChange={(e) => setSvcPrice(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              style={{ alignSelf: 'flex-end' }}
            >
              <Plus size={16} />
              <span>{t.settings.addServiceBtn.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        </form>

        <div className="table-responsive">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.settings.serviceNameRu}</th>
                <th>{t.settings.serviceNameKz}</th>
                <th>{t.settings.serviceNameEn}</th>
                <th>{t.settings.refPrice}</th>
              </tr>
            </thead>
            <tbody>
              {servicesCatalog.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name_ru}</td>
                  <td>{s.name_kz}</td>
                  <td>{s.name_en}</td>
                  <td style={{ width: 200 }}>
                    <input
                      type="number"
                      min={0}
                      step={500}
                      className="input input-sm"
                      defaultValue={s.reference_price ?? ''}
                      onBlur={(e) =>
                        handleUpdateServicePrice(s.id, e.target.value)
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Security, Password, 2FA & Encrypted Backup */}
      <div className="dashboard-grid-2">
        <div className="card">
          <h2 className="section-title icon-inline" style={{ marginTop: 0 }}>
            <ShieldCheck size={18} style={{ color: '#D4AF37' }} />
            <span>{t.settings.securitySection}</span>
          </h2>
          <p className="muted" style={{ fontSize: 12 }}>
            {t.settings.passwordGuidance}
          </p>

          <form onSubmit={handleChangePassword} className="form-stack">
            {pwStatus && (
              <div
                className={
                  pwStatus.type === 'ok' ? 'alert alert-success' : 'alert alert-error'
                }
              >
                {pwStatus.text}
              </div>
            )}
            <div className="form-group">
              <label>{t.settings.currentPassword}</label>
              <input
                type="password"
                className="input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>{t.settings.newPassword}</label>
              <input
                type="password"
                minLength={12}
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary">
              {t.settings.changePasswordBtn}
            </button>
          </form>

          <hr style={{ margin: '20px 0', borderColor: '#E2E8F0' }} />

          <h3 style={{ fontSize: 15, marginBottom: 8 }}>
            {t.settings.twoFactorTitle}
          </h3>
          {totpEnabled ? (
            <div className="badge badge-success icon-inline">
              <Check size={13} />
              <span>2FA TOTP Включена</span>
            </div>
          ) : !totpSecret ? (
            <button className="btn btn-secondary" onClick={handleSetup2fa}>
              {t.settings.setup2faBtn}
            </button>
          ) : (
            <form onSubmit={handleConfirmEnable2fa} className="form-stack">
              <div className="detail-box">
                Секретный ключ TOTP (для Google Authenticator / Authy):{' '}
                <strong>{totpSecret}</strong>
              </div>
              <input
                type="text"
                maxLength={6}
                className="input"
                placeholder="6-значный код"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Подтвердить и включить 2FA
              </button>
            </form>
          )}
        </div>

        <div className="card">
          <h2 className="section-title icon-inline" style={{ marginTop: 0 }}>
            <Database size={18} style={{ color: '#D4AF37' }} />
            <span>{t.settings.backupTitle}</span>
          </h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Создаёт зашифрованный слепок базы данных (AES-256-GCM) и автоматически
            проверяет возможность восстановления.
          </p>
          <button className="btn btn-primary" onClick={handleCreateBackup}>
            <Database size={16} />
            <span>{t.settings.createBackupBtn}</span>
          </button>

          {backupResult && (
            <div className="detail-box" style={{ marginTop: 14 }}>
              <div>
                <strong>Файл:</strong> {backupResult.fileName}
              </div>
              <div>
                <strong>Пациентов:</strong> {backupResult.counts.patients} •{' '}
                <strong>Визитов:</strong> {backupResult.counts.visits}
              </div>
              <div className="icon-inline" style={{ color: '#15803D', fontWeight: 600, marginTop: 4 }}>
                <Check size={15} />
                <span>Расшифровка и целостность резервной копии проверены</span>
              </div>
            </div>
          )}

          <hr style={{ margin: '20px 0', borderColor: '#E2E8F0' }} />

          <h3 style={{ fontSize: 15, marginBottom: 8 }}>
            {t.settings.auditTitle}
          </h3>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {auditEvents.map((ev) => (
              <div
                key={ev.id}
                style={{
                  fontSize: 12,
                  padding: '6px 0',
                  borderBottom: '1px solid #F1F5F9',
                }}
              >
                <strong>{ev.event_type}</strong>{' '}
                <span className="muted">
                  ({formatDisplayDate(ev.created_at)} • IP: {ev.ip_address || 'local'})
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
