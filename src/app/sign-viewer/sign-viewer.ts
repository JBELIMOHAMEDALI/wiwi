import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { DomSanitizer } from '@angular/platform-browser';
import { firstValueFrom, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ActivatedRoute } from '@angular/router';
import { registerLocaleData } from '@angular/common';
import localeFr from '@angular/common/locales/fr';
import { AuthPdf } from '../service/auth-pdf';
import Swal from 'sweetalert2';
import * as pdfjsLib from 'pdfjs-dist';

registerLocaleData(localeFr);

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const API_BASE   = 'https://api.prosign-lis.com';
const AGENT_BASE = 'http://localhost:53821';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface SscdCertificate {
  algorithm:    string;
  alias:        string;
  issuer:       string;
  serialNumber: string;
  subject:      string;
  type:         string;
  validFrom:    string;
  validUntil:   string;
}

interface PdfPage {
  img:        string;
  pageNumber: number;
  totalPages: number;
}

interface InvoiceSession {
  documentIdentifier: string;
  signingSessionId:   string;
  invoiceId:          string;
}

interface AcceptResponse {
  status:          string;
  signingSessions: InvoiceSession[];
}

interface PrepareSignResponse {
  signatureId:      number;
  sessionId:        string;
  signingSessionId: string;
  status:           string;
  digest:           string;
}

interface AgentSignResponse {
  signatureValue: string;
  certificate:    string;
  algorithm:      string;
  success:        boolean;
  message:        string;
}

interface InvoiceView {
  session:  InvoiceSession;
  pages:    PdfPage[];
  loading:  boolean;
  error:    string | null;
  signed:   boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector:    'app-sign-viewer',
  standalone:  true,
  imports:     [CommonModule, FormsModule],
  templateUrl: './sign-viewer.html',
  styleUrl:    './sign-viewer.scss',
})
export class SignViewer implements OnInit, OnDestroy {

  private destroy$       = new Subject<void>();
  private mainDocumentId = '';

  // ── Public state ──────────────────────────────────────────────────────────
  isLoading      = true;   // true during initial accept + PDF load
  termsAccepted  = false;
  selectedCert   = '';
  certificates:      SscdCertificate[] = [];
  expandedCertIndex: number | null     = null;
  signedSuccess  = false;
  isSigning      = false;

  invoices:    InvoiceView[] = [];
  currentPage = 0;

  signingProgress: { current: number; total: number; docId: string; invoiceId: string } | null = null;

  constructor(
    private http:      HttpClient,
    private sanitizer: DomSanitizer,
    private authPdf:   AuthPdf,
    private route:     ActivatedRoute
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.mainDocumentId = this.route.snapshot.paramMap.get('id') ?? '';

    if (!this.mainDocumentId) {
      this.isLoading = false;
      this.showError('Identifiant de document manquant.', 'Document invalide');
      return;
    }

    // Accept on page load → fetch invoices → load PDFs → show first one
    this.acceptAndLoadPdfs();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ON PAGE LOAD: accept once, then load all PDFs
  // ─────────────────────────────────────────────────────────────────────────

  async acceptAndLoadPdfs(): Promise<void> {
    this.isLoading = true;
    const url = `${API_BASE}/api/sign/${this.mainDocumentId}/accept`;

    try {
      const resp = await firstValueFrom(
        this.http.post<AcceptResponse>(url, {}, { headers: this.jsonHeaders() })
          .pipe(takeUntil(this.destroy$))
      );

      if (!resp?.signingSessions?.length) {
        this.showError("Aucune facture à signer n'a été trouvée.", 'Aucune facture');
        return;
      }

      this.invoices = resp.signingSessions.map(session => ({
        session, pages: [], loading: true, error: null, signed: false,
      }));
      this.currentPage = 0;

      // Load all PDFs in parallel
      await Promise.all(this.invoices.map((_, idx) => this.loadInvoicePdf(idx)));

    } catch (error: unknown) {
      console.error('[acceptAndLoadPdfs]', error);
      const msg = this.extractServerMessage(error) ?? 'Impossible de charger les factures.';
      this.showError(msg);
    } finally {
      this.isLoading = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Load PDF for one invoice
  // GET /sign/{mainDocumentId}/invoices/{invoiceId}/pdf
  // ─────────────────────────────────────────────────────────────────────────

  private async loadInvoicePdf(index: number): Promise<void> {
    const inv    = this.invoices[index];
    const { invoiceId } = inv.session;
    const pdfUrl = `${API_BASE}/sign/${this.mainDocumentId}/invoices/${invoiceId}/pdf`;
    let objectUrl: string | null = null;

    try {
      const pdfBlob = await firstValueFrom(
        this.http.get(pdfUrl, { responseType: 'blob' }).pipe(takeUntil(this.destroy$))
      );

      objectUrl = URL.createObjectURL(pdfBlob);
      const pdf = await pdfjsLib.getDocument(objectUrl).promise;
      const pages: PdfPage[] = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page     = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas   = document.createElement('canvas');
        const ctx      = canvas.getContext('2d');
        if (!ctx) throw new Error(`Canvas context unavailable page ${i}`);

        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
        pages.push({ img: canvas.toDataURL('image/png'), pageNumber: i, totalPages: pdf.numPages });
      }

      inv.pages   = pages;
      inv.loading = false;

    } catch (error: any) {
      console.error(`[loadInvoicePdf] invoice ${invoiceId}`, error);
      inv.loading = false;
      inv.error   = `Impossible de charger la facture ${invoiceId}.`;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Certificate type change — only called after terms accepted
  // ─────────────────────────────────────────────────────────────────────────

  onCertChange(): void {
    this.expandedCertIndex = null;
    this.certificates      = [];
    if (this.selectedCert === 'digigo') this.loadCertificates();
  }

  async loadCertificates(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<SscdCertificate[]>(`${AGENT_BASE}/api/certificates`)
      );
      if (!res || (res as any).success === false) {
        this.certificates = [];
        Swal.fire({ icon: 'warning', title: 'Aucun certificat',
          text: "Aucun certificat valide n'a été trouvé sur ce poste.", confirmButtonText: 'OK' });
        return;
      }
      this.certificates = Array.isArray(res) ? res : [];
    } catch (error: unknown) {
      this.certificates = [];
      const httpError = error as { status?: number };
      if (httpError?.status === 0) {
        Swal.fire({ icon: 'error', title: 'Agent PROSign non détecté',
          text: "Veuillez lancer l'application PROSign Agent sur votre ordinateur, puis réessayer.",
          confirmButtonText: 'OK' });
      } else {
        Swal.fire({ icon: 'warning', title: 'Clé USB non détectée',
          text: 'Veuillez insérer votre clé USB contenant un certificat valide.',
          confirmButtonText: 'OK' });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SIGN BUTTON CLICK: loop prepare → agent → complete for each invoice
  // accept was already done at page load — sessions are in this.invoices
  // ─────────────────────────────────────────────────────────────────────────

  async signWithCert(cert: SscdCertificate): Promise<void> {

    if (!this.termsAccepted) {
      Swal.fire({ icon: 'warning', title: 'Attention',
        text: 'Veuillez accepter les termes avant de signer.', confirmButtonText: 'OK' });
      return;
    }

    if (this.isSigning || this.invoices.length === 0) return;
    this.isSigning = true;

    const total  = this.invoices.length;
    const failed: string[] = [];

    try {
      // Agent check
      this.showLoading('Vérification du certificat...');
      const isValid = await this.authPdf.verifyAgentAndCertificate();
      if (!isValid) { this.isSigning = false; Swal.close(); return; }

      // Loop: one invoice at a time
      for (let i = 0; i < this.invoices.length; i++) {
        const inv = this.invoices[i];
        const { invoiceId, documentIdentifier } = inv.session;

        // Navigate to current invoice so user sees progress
        this.currentPage     = i;
        this.signingProgress = { current: i + 1, total, docId: documentIdentifier, invoiceId };

        try {
          // 1. Prepare
          this.updateLoading(
            `Facture ${i + 1}/${total} — ${documentIdentifier} (N°${invoiceId})\nPréparation…`
          );
          const prepareResp = await this.prepareSign(inv.session, cert);

          // 2. Agent signs
          this.updateLoading(
            `Facture ${i + 1}/${total} — ${documentIdentifier} (N°${invoiceId})\nSignature locale…`
          );
          const agentResp = await this.signViaAgent(prepareResp.digest, cert);

          // 3. Complete
          this.updateLoading(
            `Facture ${i + 1}/${total} — ${documentIdentifier} (N°${invoiceId})\nFinalisation…`
          );
          await this.completeSign(inv.session, prepareResp, agentResp, cert);

          inv.signed = true;

        } catch (err: unknown) {
          console.error(`[loop] invoice ${invoiceId}`, err);
          failed.push(`${documentIdentifier} (N°${invoiceId})`);
          inv.error = err instanceof Error ? err.message : 'Erreur inconnue';
        }
      }

      Swal.close();
      this.signingProgress = null;

      if (failed.length === 0) {
        await Swal.fire({
          icon: 'success', title: 'Toutes les factures signées !',
          html: `<b>${total}</b> facture(s) signée(s) avec succès.`,
          confirmButtonText: 'OK', allowOutsideClick: false, allowEscapeKey: false,
        });
        this.signedSuccess = true;
      } else {
        await Swal.fire({
          icon: 'warning', title: 'Signature partielle',
          html: `
            <p>${total - failed.length}/${total} factures signées avec succès.</p>
            <p style="color:#e53935;margin-top:10px">
              Échecs :<br/><strong>${failed.join('<br/>')}</strong>
            </p>`,
          confirmButtonText: 'OK',
        });
      }

    } catch (error: unknown) {
      console.error('[signWithCert] fatal', error);
      Swal.fire({
        icon: 'error', title: 'Erreur de signature',
        text: error instanceof Error ? error.message : 'Une erreur inattendue est survenue.',
        confirmButtonText: 'OK',
      });
    } finally {
      this.isSigning       = false;
      this.signingProgress = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Prepare — POST /api/sign/{documentIdentifier}/prepare
  // Body: { alias, token: signingSessionId, serialNumber }
  // ─────────────────────────────────────────────────────────────────────────

  private async prepareSign(session: InvoiceSession, cert: SscdCertificate): Promise<PrepareSignResponse> {
    const url     = `${API_BASE}/api/sign/${session.documentIdentifier}/prepare`;
    const payload = { alias: cert.alias, token: session.signingSessionId, serialNumber: cert.serialNumber };
    try {
      const response = await firstValueFrom(
        this.http.post<PrepareSignResponse>(url, payload, { headers: this.jsonHeaders() })
      );
      if (!response?.digest) throw new Error('Digest absent de la réponse de préparation.');
      return response;
    } catch (error: unknown) {
      const msg = this.extractServerMessage(error);
      throw new Error(msg ?? `Échec de la préparation pour la facture ${session.invoiceId}.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent sign — POST localhost:53821/api/certificates/signe
  // Body: { digest, algorithm, alias }
  // ─────────────────────────────────────────────────────────────────────────

  private async signViaAgent(digest: string, cert: SscdCertificate): Promise<AgentSignResponse> {
    const payload = { digest, algorithm: cert.algorithm, alias: cert.alias };
    try {
      const response = await firstValueFrom(
        this.http.post<AgentSignResponse>(`${AGENT_BASE}/api/certificates/signe`,
          payload, { headers: this.jsonHeaders() })
      );
      if (!response?.signatureValue || !response?.certificate) {
        throw new Error("Réponse de l'agent invalide.");
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof Error) throw error;
      const httpError = error as { status?: number };
      if (httpError?.status === 0) throw new Error("L'agent PROSign n'est plus accessible.");
      throw new Error("Échec de la signature via l'agent local.");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Complete — POST /api/sign/{documentIdentifier}/complete
  // Body: { signingSessionId (from prepare), signatureValue, certificate, algorithm }
  // ─────────────────────────────────────────────────────────────────────────

  private async completeSign(
    session: InvoiceSession, prepareResp: PrepareSignResponse,
    agentResp: AgentSignResponse, cert: SscdCertificate
  ): Promise<void> {
    const url     = `${API_BASE}/api/sign/${session.documentIdentifier}/complete`;
    const payload = {
      signingSessionId: prepareResp.signingSessionId,
      signatureValue:   agentResp.signatureValue,
      certificate:      agentResp.certificate,
      algorithm:        cert.algorithm,
    };
    try {
      await firstValueFrom(this.http.post(url, payload, { headers: this.jsonHeaders() }));
    } catch (error: unknown) {
      const msg = this.extractServerMessage(error);
      throw new Error(msg ?? `Échec de la finalisation pour la facture ${session.invoiceId}.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pagination
  // ─────────────────────────────────────────────────────────────────────────

  get totalInvoices(): number              { return this.invoices.length; }
  get currentInvoice(): InvoiceView | null { return this.invoices[this.currentPage] ?? null; }

  goToPage(index: number): void {
    if (index >= 0 && index < this.totalInvoices) this.currentPage = index;
  }
  prevPage(): void { this.goToPage(this.currentPage - 1); }
  nextPage(): void { this.goToPage(this.currentPage + 1); }

  // ─────────────────────────────────────────────────────────────────────────
  // Template helpers
  // ─────────────────────────────────────────────────────────────────────────

  getIssuerCN(issuer: string): string {
    const match = issuer?.match(/CN=([^,]+)/);
    return match ? match[1] : issuer;
  }

  get allSigned(): boolean {
    return this.invoices.length > 0 && this.invoices.every(inv => inv.signed);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────

  private jsonHeaders(): HttpHeaders {
    return new HttpHeaders({ 'Content-Type': 'application/json' });
  }

  private showLoading(text: string): void {
    Swal.fire({ title: 'Traitement en cours…', text,
      allowOutsideClick: false, allowEscapeKey: false, didOpen: () => Swal.showLoading() });
  }

  private updateLoading(text: string): void { Swal.update({ text }); }

  private showError(text: string, title = 'Erreur'): void {
    Swal.fire({ icon: 'error', title, text, confirmButtonText: 'OK' });
  }

  private extractServerMessage(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const e = error as { error?: { message?: string }; message?: string };
    return e?.error?.message ?? e?.message ?? null;
  }
}