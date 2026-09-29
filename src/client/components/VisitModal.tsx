import React, { useState, useEffect, useRef } from 'react';
import { X, Camera, Paperclip, Plus } from 'lucide-react';
import {
  formatKzt,
  type Language,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch, ApiError } from '../services/api';
import { saveFormDraft, loadFormDraft, clearFormDraft } from '../services/offlineQueue';

interface Props {
  t: TranslationDict;
  lang: Language;
  patientId: string;
  patientName: string;
  servicesCatalog: any[];
  existingVisit?: any | null;
  initialService?: string;
  initialPrice?: number | null;
  onClose: () => void;
  onSaved: (visit: any) => void;
  onSyncNotice: (msg: string) => void;
}

export function VisitModal({
  t,
  lang,
  patientId,
  patientName,
  servicesCatalog,
  existingVisit = null,
  initialService = '',
  initialPrice = null,
  onClose,
  onSaved,
  onSyncNotice,
}: Props) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const draftKey = existingVisit
    ? `visit_edit_${existingVisit.id}`
    : `visit_new_${patientId}`;

  const [visitDate, setVisitDate] = useState(existingVisit?.visit_date || todayIso);
  const [visitTime, setVisitTime] = useState(
    existingVisit?.visit_time || new Date().toTimeString().slice(0, 5)
  );
  const [serviceId, setServiceId] = useState<string | null>(
    existingVisit?.service_id || null
  );
  const [serviceText, setServiceText] = useState(
    existingVisit?.service_name_snapshot || initialService
  );
  const [price, setPrice] = useState<string>(
    existingVisit?.price !== undefined
      ? String(existingVisit.price)
      : initialPrice !== null && initialPrice !== undefined
      ? String(initialPrice)
      : ''
  );
  const [suggestedRefPrice, setSuggestedRefPrice] = useState<number | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid'>(
    existingVisit?.payment_status || 'paid'
  );
  const [paymentDate, setPaymentDate] = useState(
    existingVisit?.payment_date || todayIso
  );
  const [doctorName, setDoctorName] = useState(existingVisit?.doctor_name || '');

  // Optional expandable medical sections (only shown if expanded or non-empty)
  const [complaints, setComplaints] = useState(existingVisit?.complaints || '');
  const [diagnosis, setDiagnosis] = useState(existingVisit?.diagnosis || '');
  const [treatment, setTreatment] = useState(existingVisit?.treatment || '');
  const [recommendations, setRecommendations] = useState(
    existingVisit?.recommendations || ''
  );
  const [comments, setComments] = useState(existingVisit?.comments || '');

  const [expandedFields, setExpandedFields] = useState<Record<string, boolean>>({
    complaints: Boolean(existingVisit?.complaints),
    diagnosis: Boolean(existingVisit?.diagnosis),
    treatment: Boolean(existingVisit?.treatment),
    recommendations: Boolean(existingVisit?.recommendations),
    comments: Boolean(existingVisit?.comments),
  });

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Restore draft on mount if creating a new visit
  useEffect(() => {
    if (!existingVisit && !initialService) {
      loadFormDraft<Record<string, any>>(draftKey).then((d) => {
        if (d) {
          if (d.serviceText) setServiceText(d.serviceText);
          if (d.price !== undefined) setPrice(String(d.price));
          if (d.doctorName) setDoctorName(d.doctorName);
          if (d.complaints) {
            setComplaints(d.complaints);
            setExpandedFields((p) => ({ ...p, complaints: true }));
          }
          if (d.diagnosis) {
            setDiagnosis(d.diagnosis);
            setExpandedFields((p) => ({ ...p, diagnosis: true }));
          }
          if (d.treatment) {
            setTreatment(d.treatment);
            setExpandedFields((p) => ({ ...p, treatment: true }));
          }
          if (d.recommendations) {
            setRecommendations(d.recommendations);
            setExpandedFields((p) => ({ ...p, recommendations: true }));
          }
          if (d.comments) {
            setComments(d.comments);
            setExpandedFields((p) => ({ ...p, comments: true }));
          }
        }
      });
    }
  }, [draftKey, existingVisit, initialService]);

  // Autosave draft to encrypted IndexedDB
  useEffect(() => {
    const timer = setTimeout(() => {
      if (serviceText || complaints || diagnosis || treatment || comments) {
        saveFormDraft(draftKey, {
          serviceText,
          price,
          doctorName,
          complaints,
          diagnosis,
          treatment,
          recommendations,
          comments,
        });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [
    draftKey,
    serviceText,
    price,
    doctorName,
    complaints,
    diagnosis,
    treatment,
    recommendations,
    comments,
  ]);

  function getLocalizedServiceName(svc: any): string {
    if (lang === 'kz') return svc.name_kz || svc.name_ru;
    if (lang === 'en') return svc.name_en || svc.name_ru;
    return svc.name_ru;
  }

  const matchingServices = servicesCatalog.filter((svc) => {
    if (!svc.active) return false;
    const q = serviceText.trim().toLowerCase();
    if (!q) return true;
    return (
      svc.name_ru.toLowerCase().includes(q) ||
      svc.name_kz.toLowerCase().includes(q) ||
      svc.name_en.toLowerCase().includes(q)
    );
  });

  function selectSuggestedService(svc: any) {
    setServiceId(svc.id);
    setServiceText(getLocalizedServiceName(svc));
    if (svc.reference_price !== null && svc.reference_price !== undefined) {
      setSuggestedRefPrice(Number(svc.reference_price));
      setPrice(String(svc.reference_price));
    }
    setShowSuggestions(false);
  }

  async function uploadFileForVisit(file: File, targetVisitId: string) {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('File read error'));
      reader.readAsDataURL(file);
    });

    await apiFetch('/api/attachments/upload', {
      method: 'POST',
      body: {
        patient_id: patientId,
        visit_id: targetVisitId,
        file_name: file.name,
        mime_type: file.type,
        content_base64: base64,
      },
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!serviceText.trim()) {
      setError('Укажите оказанную услугу.');
      return;
    }

    const numericPrice = Number(price || 0);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      setError('Укажите корректную стоимость услуги.');
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        visit_date: visitDate,
        visit_time: visitTime || null,
        service_id: serviceId,
        service_name_snapshot: serviceText.trim(),
        price: Math.round(numericPrice),
        payment_status: paymentStatus,
        payment_date: paymentStatus === 'paid' ? paymentDate || visitDate : null,
        doctor_name: doctorName.trim() || null,
        complaints: complaints.trim() || null,
        diagnosis: diagnosis.trim() || null,
        treatment: treatment.trim() || null,
        recommendations: recommendations.trim() || null,
        comments: comments.trim() || null,
      };

      let savedVisit: any;
      if (existingVisit) {
        payload.expected_updated_at = existingVisit.updated_at;
        const res = await apiFetch<{ visit: any }>(`/api/visits/${existingVisit.id}`, {
          method: 'PATCH',
          body: payload,
          allowOfflineQueue: true,
        });
        savedVisit = res.visit;
      } else {
        payload.patient_id = patientId;
        const res = await apiFetch<{ visit: any }>('/api/visits', {
          method: 'POST',
          body: payload,
          allowOfflineQueue: true,
        });
        savedVisit = res.visit;
      }

      // Upload any attached photos/files
      for (const file of pendingFiles) {
        await uploadFileForVisit(file, savedVisit.id);
      }

      await clearFormDraft(draftKey);
      onSaved(savedVisit);
    } catch (err) {
      if (err instanceof ApiError && err.queuedOffline) {
        onSyncNotice(t.sync.offlineQueued);
        onClose();
        return;
      }
      setError(err instanceof Error ? err.message : 'Ошибка сохранения визита');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-card-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3>{existingVisit ? t.visit.editTitle : t.visit.newTitle}</h3>
            <div className="muted" style={{ fontSize: 13 }}>
              {patientName}
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="form-stack">
          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-row-2">
            <div className="form-group">
              <label>{t.patients.date}</label>
              <input
                type="date"
                className="input"
                value={visitDate}
                onChange={(e) => setVisitDate(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>{t.patients.time}</label>
              <input
                type="time"
                className="input"
                value={visitTime}
                onChange={(e) => setVisitTime(e.target.value)}
              />
            </div>
          </div>

          {/* Service input with dynamic suggestions (does NOT auto-select) */}
          <div className="form-group" style={{ position: 'relative' }}>
            <label>{t.patients.service} *</label>
            <input
              type="text"
              className="input"
              value={serviceText}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 180)}
              onChange={(e) => {
                setServiceText(e.target.value);
                setServiceId(null);
                setShowSuggestions(true);
              }}
              placeholder={t.visit.servicePlaceholder}
              required
              autoFocus
            />

            {showSuggestions && matchingServices.length > 0 && (
              <div className="autocomplete-dropdown">
                {matchingServices.map((svc) => (
                  <button
                    type="button"
                    key={svc.id}
                    className="autocomplete-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestedService(svc);
                    }}
                  >
                    <span>{getLocalizedServiceName(svc)}</span>
                    {svc.reference_price !== null && (
                      <span className="gold-badge">{formatKzt(svc.reference_price)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="form-row-3">
            <div className="form-group">
              <label>{t.patients.price} (₸) *</label>
              <input
                type="number"
                min={0}
                step={500}
                className="input"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="30000"
                required
              />
              {suggestedRefPrice !== null && (
                <small className="muted">
                  {t.visit.standardPriceHint} {formatKzt(suggestedRefPrice)}
                </small>
              )}
            </div>

            <div className="form-group">
              <label>{t.patients.paymentStatus}</label>
              <select
                className="input"
                value={paymentStatus}
                onChange={(e) => setPaymentStatus(e.target.value as 'paid' | 'unpaid')}
              >
                <option value="paid">{t.patients.paid}</option>
                <option value="unpaid">{t.patients.unpaid}</option>
              </select>
            </div>

            <div className="form-group">
              <label>{t.patients.doctor}</label>
              <input
                type="text"
                className="input"
                value={doctorName}
                onChange={(e) => setDoctorName(e.target.value)}
                placeholder={t.visit.doctorPlaceholder}
              />
            </div>
          </div>

          {/* Optional Expandable Medical Sections ("+ Добавить") */}
          <div className="optional-sections-box">
            <div className="optional-sections-title">{t.visit.optionalMedicalHeader}</div>

            <div className="chip-row">
              {!expandedFields.complaints && (
                <button
                  type="button"
                  className="chip-btn icon-inline"
                  onClick={() => setExpandedFields((p) => ({ ...p, complaints: true }))}
                >
                  <Plus size={13} />
                  <span>{t.visit.addComplaints.replace(/^\+\s*/, '')}</span>
                </button>
              )}
              {!expandedFields.diagnosis && (
                <button
                  type="button"
                  className="chip-btn icon-inline"
                  onClick={() => setExpandedFields((p) => ({ ...p, diagnosis: true }))}
                >
                  <Plus size={13} />
                  <span>{t.visit.addDiagnosis.replace(/^\+\s*/, '')}</span>
                </button>
              )}
              {!expandedFields.treatment && (
                <button
                  type="button"
                  className="chip-btn icon-inline"
                  onClick={() => setExpandedFields((p) => ({ ...p, treatment: true }))}
                >
                  <Plus size={13} />
                  <span>{t.visit.addTreatment.replace(/^\+\s*/, '')}</span>
                </button>
              )}
              {!expandedFields.recommendations && (
                <button
                  type="button"
                  className="chip-btn icon-inline"
                  onClick={() =>
                    setExpandedFields((p) => ({ ...p, recommendations: true }))
                  }
                >
                  <Plus size={13} />
                  <span>{t.visit.addRecommendations.replace(/^\+\s*/, '')}</span>
                </button>
              )}
              {!expandedFields.comments && (
                <button
                  type="button"
                  className="chip-btn icon-inline"
                  onClick={() => setExpandedFields((p) => ({ ...p, comments: true }))}
                >
                  <Plus size={13} />
                  <span>{t.visit.addComments.replace(/^\+\s*/, '')}</span>
                </button>
              )}
            </div>

            {expandedFields.complaints && (
              <div className="form-group" style={{ marginTop: 10 }}>
                <label>{t.visit.complaints}</label>
                <textarea
                  className="input"
                  rows={2}
                  value={complaints}
                  onChange={(e) => setComplaints(e.target.value)}
                />
              </div>
            )}

            {expandedFields.diagnosis && (
              <div className="form-group" style={{ marginTop: 10 }}>
                <label>{t.visit.diagnosis}</label>
                <input
                  type="text"
                  className="input"
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                />
              </div>
            )}

            {expandedFields.treatment && (
              <div className="form-group" style={{ marginTop: 10 }}>
                <label>{t.visit.treatment}</label>
                <textarea
                  className="input"
                  rows={2}
                  value={treatment}
                  onChange={(e) => setTreatment(e.target.value)}
                />
              </div>
            )}

            {expandedFields.recommendations && (
              <div className="form-group" style={{ marginTop: 10 }}>
                <label>{t.visit.recommendations}</label>
                <textarea
                  className="input"
                  rows={2}
                  value={recommendations}
                  onChange={(e) => setRecommendations(e.target.value)}
                />
              </div>
            )}

            {expandedFields.comments && (
              <div className="form-group" style={{ marginTop: 10 }}>
                <label>{t.visit.comments}</label>
                <input
                  type="text"
                  className="input"
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                />
              </div>
            )}

            {/* Photos & Files attachment controls */}
            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
                {t.visit.photosAndFiles}
              </label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) setPendingFiles((p) => [...p, ...files]);
                  }}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,.heic,.pdf"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) setPendingFiles((p) => [...p, ...files]);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera size={15} />
                  <span>{t.visit.takePhotoBtn}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={15} />
                  <span>{t.visit.uploadFileBtn}</span>
                </button>
              </div>

              {pendingFiles.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {pendingFiles.map((f, idx) => (
                    <span key={idx} className="badge badge-neutral icon-inline">
                      <span>{f.name}</span>
                      <button
                        type="button"
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          marginLeft: 4,
                          display: 'inline-flex',
                          alignItems: 'center',
                        }}
                        onClick={() =>
                          setPendingFiles((p) => p.filter((_, i) => i !== idx))
                        }
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
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
