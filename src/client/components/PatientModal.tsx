import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { TranslationDict } from '../i18n/translations';
import { apiFetch, ApiError } from '../services/api';
import { saveFormDraft, loadFormDraft, clearFormDraft } from '../services/offlineQueue';
import { validateKzIin } from '../../shared/validation/schemas';

interface Props {
  t: TranslationDict;
  initialName?: string;
  existingPatient?: any | null;
  onClose: () => void;
  onSaved: (patient: any) => void;
  onSyncNotice: (msg: string) => void;
}

export function PatientModal({
  t,
  initialName = '',
  existingPatient = null,
  onClose,
  onSaved,
  onSyncNotice,
}: Props) {
  const draftKey = existingPatient
    ? `patient_edit_${existingPatient.id}`
    : 'patient_new_draft';

  const [fullName, setFullName] = useState(existingPatient?.full_name || initialName);
  const [phone, setPhone] = useState(existingPatient?.phone || '');
  const [iin, setIin] = useState(existingPatient?.iin || '');
  const [dob, setDob] = useState(existingPatient?.date_of_birth || '');
  const [allergies, setAllergies] = useState(existingPatient?.allergies || '');
  const [medicalNotes, setMedicalNotes] = useState(existingPatient?.medical_notes || '');
  const [additionalInfo, setAdditionalInfo] = useState(existingPatient?.additional_info || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Restore draft if creating a new patient and no initialName override
  useEffect(() => {
    if (!existingPatient && !initialName) {
      loadFormDraft<Record<string, string>>(draftKey).then((d) => {
        if (d) {
          if (d.fullName) setFullName(d.fullName);
          if (d.phone) setPhone(d.phone);
          if (d.iin) setIin(d.iin);
          if (d.dob) setDob(d.dob);
          if (d.allergies) setAllergies(d.allergies);
          if (d.medicalNotes) setMedicalNotes(d.medicalNotes);
          if (d.additionalInfo) setAdditionalInfo(d.additionalInfo);
        }
      });
    }
  }, [draftKey, existingPatient, initialName]);

  // Autosave draft to encrypted IndexedDB as user types
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fullName || phone || iin || allergies || medicalNotes) {
        saveFormDraft(draftKey, {
          fullName,
          phone,
          iin,
          dob,
          allergies,
          medicalNotes,
          additionalInfo,
        });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [draftKey, fullName, phone, iin, dob, allergies, medicalNotes, additionalInfo]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (fullName.trim().length < 2) {
      setError('Укажите ФИО пациента.');
      return;
    }

    const cleanIin = iin.replace(/\s+/g, '');
    if (cleanIin && !validateKzIin(cleanIin)) {
      setError('Проверьте правильность 12-значного ИИН (контрольный разряд или дата).');
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        iin: cleanIin || null,
        date_of_birth: dob || null,
        allergies: allergies.trim() || null,
        medical_notes: medicalNotes.trim() || null,
        additional_info: additionalInfo.trim() || null,
      };

      if (existingPatient) {
        payload.expected_updated_at = existingPatient.updated_at;
        const res = await apiFetch<{ patient: any }>(`/api/patients/${existingPatient.id}`, {
          method: 'PATCH',
          body: payload,
          allowOfflineQueue: true,
        });
        await clearFormDraft(draftKey);
        onSaved(res.patient);
      } else {
        const res = await apiFetch<{ patient: any }>('/api/patients', {
          method: 'POST',
          body: payload,
          allowOfflineQueue: true,
        });
        await clearFormDraft(draftKey);
        onSaved(res.patient);
      }
    } catch (err) {
      if (err instanceof ApiError && err.queuedOffline) {
        onSyncNotice(t.sync.offlineQueued);
        onClose();
        return;
      }
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{existingPatient ? t.patients.editModalTitle : t.patients.createModalTitle}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="form-stack">
          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-group">
            <label>{t.patients.fullName}</label>
            <input
              type="text"
              className="input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Каримов Артём Серикович"
              required
              autoFocus
            />
          </div>

          <div className="form-row-2">
            <div className="form-group">
              <label>{t.patients.phone}</label>
              <input
                type="tel"
                className="input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7 701 000 00 00"
              />
            </div>

            <div className="form-group">
              <label>{t.patients.dob}</label>
              <input
                type="date"
                className="input"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label>{t.patients.iin}</label>
            <input
              type="text"
              className="input"
              maxLength={12}
              value={iin}
              onChange={(e) => setIin(e.target.value.replace(/\D/g, ''))}
              placeholder="12 цифр (можно добавить позже)"
            />
          </div>

          <div className="form-group">
            <label>{t.patients.allergies}</label>
            <input
              type="text"
              className="input"
              value={allergies}
              onChange={(e) => setAllergies(e.target.value)}
              placeholder="Например: Лидокаин, пенициллин..."
            />
          </div>

          <div className="form-group">
            <label>{t.patients.medicalNotes}</label>
            <textarea
              className="input"
              rows={2}
              value={medicalNotes}
              onChange={(e) => setMedicalNotes(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>{t.patients.additionalInfo}</label>
            <input
              type="text"
              className="input"
              value={additionalInfo}
              onChange={(e) => setAdditionalInfo(e.target.value)}
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t.patients.cancelBtn}
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {t.patients.saveBtn}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
