import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft,
  Printer,
  Pencil,
  Archive,
  Phone,
  Cake,
  Eye,
  EyeOff,
  Plus,
  AlertTriangle,
  Camera,
  Paperclip,
  Download,
  X,
} from 'lucide-react';
import {
  formatDisplayDate,
  formatKzt,
  type Language,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch } from '../services/api';
import {
  printPatientCardAndHistory,
  printSingleVisitDetail,
} from '../utils/print';
import { PatientModal } from './PatientModal';
import { VisitModal } from './VisitModal';

interface Props {
  t: TranslationDict;
  lang: Language;
  patientId: string;
  clinic: any;
  servicesCatalog: any[];
  onBack: () => void;
  onArchived: () => void;
  onSyncNotice: (msg: string) => void;
}

export function PatientCardView({
  t,
  lang,
  patientId,
  clinic,
  servicesCatalog,
  onBack,
  onArchived,
  onSyncNotice,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [patient, setPatient] = useState<any | null>(null);
  const [summary, setSummary] = useState({
    visitCount: 0,
    totalServicesAmount: 0,
    totalPaid: 0,
    outstandingAmount: 0,
  });
  const [visits, setVisits] = useState<any[]>([]);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [showFullIin, setShowFullIin] = useState(false);

  const [editingPatient, setEditingPatient] = useState(false);
  const [addingVisit, setAddingVisit] = useState(false);
  const [editingVisit, setEditingVisit] = useState<any | null>(null);
  const [selectedVisitDetail, setSelectedVisitDetail] = useState<any | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const loadPatientCard = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/patients/${patientId}`);
      setPatient(data.patient);
      setSummary(data.summary);
      setVisits(data.visits || []);
      setAttachments(data.attachments || []);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    loadPatientCard();
  }, [loadPatientCard]);

  async function handleTogglePaymentStatus(visit: any) {
    const newStatus = visit.payment_status === 'paid' ? 'unpaid' : 'paid';
    const today = new Date().toISOString().slice(0, 10);
    await apiFetch(`/api/visits/${visit.id}`, {
      method: 'PATCH',
      body: {
        payment_status: newStatus,
        payment_date: newStatus === 'paid' ? today : null,
      },
      allowOfflineQueue: true,
    });
    loadPatientCard();
  }

  async function handleArchivePatient() {
    await apiFetch(`/api/patients/${patientId}/archive`, { method: 'POST' });
    onArchived();
  }

  async function handleArchiveVisit(visitId: string) {
    await apiFetch(`/api/visits/${visitId}/archive`, { method: 'POST' });
    setSelectedVisitDetail(null);
    loadPatientCard();
  }

  async function handleDirectFileUpload(files: FileList | null, visitId?: string) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
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
          visit_id: visitId || null,
          file_name: file.name,
          mime_type: file.type,
          content_base64: base64,
        },
      });
    }
    loadPatientCard();
  }

  if (loading) {
    return (
      <div className="skeleton-stack">
        <div className="skeleton-card" style={{ height: 140 }} />
        <div className="skeleton-card" style={{ height: 90 }} />
        <div className="skeleton-card" style={{ height: 260 }} />
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="card">
        <p>Пациент не найден.</p>
        <button className="btn btn-secondary" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>{t.nav.patients}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="page-stack">
      {/* Top Breadcrumb & Quick Actions */}
      <div className="row-between">
        <button className="btn btn-ghost" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>{t.nav.patients}</span>
        </button>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary"
            onClick={() =>
              printPatientCardAndHistory({
                clinic,
                patient,
                summary,
                visits,
                t,
              })
            }
          >
            <Printer size={16} />
            <span>{t.patients.printCard}</span>
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setEditingPatient(true)}
          >
            <Pencil size={15} />
            <span>{t.patients.editModalTitle}</span>
          </button>
          <button className="btn btn-danger-outline" onClick={handleArchivePatient}>
            <Archive size={15} />
            <span>{t.patients.archivePatient}</span>
          </button>
        </div>
      </div>

      {/* Patient Card Header */}
      <div className="card patient-header-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1 className="patient-title">{patient.full_name}</h1>
            <div className="patient-meta-row">
              {patient.phone && (
                <span className="meta-item icon-inline">
                  <Phone size={14} />
                  <span>{patient.phone}</span>
                </span>
              )}
              {patient.date_of_birth && (
                <span className="meta-item icon-inline">
                  <Cake size={14} />
                  <span>{formatDisplayDate(patient.date_of_birth)}</span>
                </span>
              )}
              {patient.iin && (
                <span className="meta-item icon-inline">
                  <span>
                    ИИН: <strong>{showFullIin ? patient.iin : patient.iin_masked}</strong>
                  </span>
                  <button
                    type="button"
                    className="btn-link icon-inline"
                    onClick={() => setShowFullIin((v) => !v)}
                  >
                    {showFullIin ? <EyeOff size={14} /> : <Eye size={14} />}
                    <span>{showFullIin ? t.patients.hideIin : t.patients.showIin}</span>
                  </button>
                </span>
              )}
            </div>
          </div>

          <button
            className="btn btn-primary btn-lg"
            onClick={() => setAddingVisit(true)}
          >
            <Plus size={18} />
            <span>{t.patients.addVisitBtn.replace(/^\+\s*/, '')}</span>
          </button>
        </div>

        {patient.allergies && (
          <div className="allergy-banner icon-inline" style={{ marginTop: 14 }}>
            <AlertTriangle size={16} />
            <span>
              <strong>{t.patients.allergies}:</strong> {patient.allergies}
            </span>
          </div>
        )}

        {(patient.medical_notes || patient.additional_info) && (
          <div className="patient-notes-grid">
            {patient.medical_notes && (
              <div>
                <div className="field-label">{t.patients.medicalNotes}</div>
                <div className="field-value">{patient.medical_notes}</div>
              </div>
            )}
            {patient.additional_info && (
              <div>
                <div className="field-label">{t.patients.additionalInfo}</div>
                <div className="field-value">{patient.additional_info}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Summary Metric Cards */}
      <div className="metrics-grid-4">
        <div className="metric-card">
          <div className="metric-label">{t.patients.visitsCount}</div>
          <div className="metric-value">{summary.visitCount}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t.patients.totalServices}</div>
          <div className="metric-value">{formatKzt(summary.totalServicesAmount)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t.patients.totalPaid}</div>
          <div className="metric-value metric-paid">{formatKzt(summary.totalPaid)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t.patients.outstanding}</div>
          <div
            className={`metric-value ${
              summary.outstandingAmount > 0 ? 'metric-unpaid' : ''
            }`}
          >
            {formatKzt(summary.outstandingAmount)}
          </div>
        </div>
      </div>

      {/* Main Section: Treatment History Table ("История лечения") */}
      <div className="card">
        <div className="row-between" style={{ marginBottom: 16 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            {t.patients.treatmentHistory}
          </h2>
          <button
            className="btn btn-primary"
            onClick={() => setAddingVisit(true)}
          >
            <Plus size={16} />
            <span>{t.patients.addVisitBtn.replace(/^\+\s*/, '')}</span>
          </button>
        </div>

        {visits.length === 0 ? (
          <div className="empty-state">
            <p>{t.patients.emptyHistory}</p>
            <button
              className="btn btn-primary"
              onClick={() => setAddingVisit(true)}
            >
              <Plus size={16} />
              <span>{t.patients.addFirstVisit.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.patients.date}</th>
                  <th>{t.patients.service}</th>
                  <th>{t.patients.price}</th>
                  <th>{t.patients.paymentStatus}</th>
                  <th>{t.patients.doctor}</th>
                  <th style={{ textAlign: 'right' }}>{t.patients.details}</th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => (
                  <tr key={v.id}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                      {formatDisplayDate(v.visit_date)}
                      {v.visit_time && (
                        <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>
                          {v.visit_time}
                        </span>
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{v.service_name_snapshot}</div>
                      {v.diagnosis && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {v.diagnosis}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                      {formatKzt(v.price)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`badge ${
                          v.payment_status === 'paid'
                            ? 'badge-success'
                            : 'badge-warning'
                        }`}
                        style={{ cursor: 'pointer', border: 'none' }}
                        title="Нажмите для смены статуса оплаты"
                        onClick={() => handleTogglePaymentStatus(v)}
                      >
                        {v.payment_status === 'paid'
                          ? t.patients.paid
                          : t.patients.unpaid}
                      </button>
                    </td>
                    <td>{v.doctor_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setSelectedVisitDetail(v)}
                      >
                        {t.patients.details}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Patient Photos & Files Section */}
      <div className="card">
        <div className="row-between" style={{ marginBottom: 14 }}>
          <h3 className="section-title" style={{ margin: 0 }}>
            {t.visit.photosAndFiles} ({attachments.length})
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => handleDirectFileUpload(e.target.files)}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.heic,.pdf"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => handleDirectFileUpload(e.target.files)}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => cameraInputRef.current?.click()}
            >
              <Camera size={15} />
              <span>{t.visit.takePhotoBtn}</span>
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={15} />
              <span>{t.visit.uploadFileBtn}</span>
            </button>
          </div>
        </div>

        {attachments.length > 0 && (
          <div className="attachments-grid">
            {attachments.map((att) => (
              <div key={att.id} className="attachment-card">
                <div style={{ fontWeight: 600, fontSize: 13 }}>{att.file_name}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {formatDisplayDate(att.created_at)} •{' '}
                  {Math.round(att.file_size / 1024)} KB
                </div>
                <div style={{ marginTop: 8 }}>
                  <a
                    href={att.download_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-secondary btn-sm"
                  >
                    <Download size={14} />
                    <span>Открыть / Скачать</span>
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Visit Detail Drawer / Modal ("Подробнее") */}
      {selectedVisitDetail && (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedVisitDetail(null)}
        >
          <div
            className="modal-card modal-card-wide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h3>{t.visit.detailTitle}</h3>
                <div className="muted">
                  {formatDisplayDate(selectedVisitDetail.visit_date)}{' '}
                  {selectedVisitDetail.visit_time || ''}
                </div>
              </div>
              <button
                className="btn-icon"
                onClick={() => setSelectedVisitDetail(null)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="visit-detail-grid">
              <div>
                <div className="field-label">{t.patients.service}</div>
                <div className="field-value" style={{ fontWeight: 700, fontSize: 16 }}>
                  {selectedVisitDetail.service_name_snapshot}
                </div>
              </div>
              <div>
                <div className="field-label">{t.patients.price}</div>
                <div className="field-value" style={{ fontWeight: 700, fontSize: 16 }}>
                  {formatKzt(selectedVisitDetail.price)}{' '}
                  <span
                    className={`badge ${
                      selectedVisitDetail.payment_status === 'paid'
                        ? 'badge-success'
                        : 'badge-warning'
                    }`}
                  >
                    {selectedVisitDetail.payment_status === 'paid'
                      ? t.patients.paid
                      : t.patients.unpaid}
                  </span>
                </div>
              </div>
              <div>
                <div className="field-label">{t.patients.doctor}</div>
                <div className="field-value">
                  {selectedVisitDetail.doctor_name || '—'}
                </div>
              </div>
              <div>
                <div className="field-label">{t.patients.paymentDate}</div>
                <div className="field-value">
                  {formatDisplayDate(selectedVisitDetail.payment_date)}
                </div>
              </div>
            </div>

            <div className="form-stack" style={{ marginTop: 16 }}>
              {selectedVisitDetail.complaints && (
                <div>
                  <div className="field-label">{t.visit.complaints}</div>
                  <div className="detail-box">{selectedVisitDetail.complaints}</div>
                </div>
              )}
              {selectedVisitDetail.diagnosis && (
                <div>
                  <div className="field-label">{t.visit.diagnosis}</div>
                  <div className="detail-box">{selectedVisitDetail.diagnosis}</div>
                </div>
              )}
              {selectedVisitDetail.treatment && (
                <div>
                  <div className="field-label">{t.visit.treatment}</div>
                  <div className="detail-box">{selectedVisitDetail.treatment}</div>
                </div>
              )}
              {selectedVisitDetail.recommendations && (
                <div>
                  <div className="field-label">{t.visit.recommendations}</div>
                  <div className="detail-box">
                    {selectedVisitDetail.recommendations}
                  </div>
                </div>
              )}
              {selectedVisitDetail.comments && (
                <div>
                  <div className="field-label">{t.visit.comments}</div>
                  <div className="detail-box">{selectedVisitDetail.comments}</div>
                </div>
              )}

              {/* Attachments belonging to this visit */}
              {attachments.filter((a) => a.visit_id === selectedVisitDetail.id)
                .length > 0 && (
                <div>
                  <div className="field-label">{t.visit.photosAndFiles}</div>
                  <div className="attachments-grid" style={{ marginTop: 6 }}>
                    {attachments
                      .filter((a) => a.visit_id === selectedVisitDetail.id)
                      .map((att) => (
                        <div key={att.id} className="attachment-card">
                          <div style={{ fontWeight: 600 }}>{att.file_name}</div>
                          <a
                            href={att.download_url}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-secondary btn-sm"
                            style={{ marginTop: 6 }}
                          >
                            <Download size={14} />
                            <span>Открыть файл</span>
                          </a>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>

            <div className="modal-actions" style={{ marginTop: 22 }}>
              <button
                type="button"
                className="btn btn-danger-outline"
                onClick={() => handleArchiveVisit(selectedVisitDetail.id)}
              >
                <Archive size={15} />
                <span>{t.visit.archiveVisit}</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  printSingleVisitDetail({
                    clinic,
                    patientName: patient.full_name,
                    visit: selectedVisitDetail,
                    t,
                  })
                }
              >
                <Printer size={15} />
                <span>{t.visit.printVisit}</span>
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const v = selectedVisitDetail;
                  setSelectedVisitDetail(null);
                  setEditingVisit(v);
                }}
              >
                <Pencil size={15} />
                <span>{t.visit.editTitle}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {editingPatient && (
        <PatientModal
          t={t}
          existingPatient={patient}
          onClose={() => setEditingPatient(false)}
          onSaved={() => {
            setEditingPatient(false);
            loadPatientCard();
          }}
          onSyncNotice={onSyncNotice}
        />
      )}

      {(addingVisit || editingVisit) && (
        <VisitModal
          t={t}
          lang={lang}
          patientId={patientId}
          patientName={patient.full_name}
          servicesCatalog={servicesCatalog}
          existingVisit={editingVisit}
          onClose={() => {
            setAddingVisit(false);
            setEditingVisit(null);
          }}
          onSaved={() => {
            setAddingVisit(false);
            setEditingVisit(null);
            loadPatientCard();
          }}
          onSyncNotice={onSyncNotice}
        />
      )}
    </div>
  );
}
