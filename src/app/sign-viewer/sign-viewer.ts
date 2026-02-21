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
  session:      InvoiceSession;
  pages:        PdfPage[];
  loading:      boolean;
  error:        string | null;
  signed:       boolean;
  prepareResp?: PrepareSignResponse;  // stored after step 1 (prepare)
  agentResp?:   AgentSignResponse;    // stored after step 2 (agent sign)
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
  isLoading      = true;
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

    this.acceptAndLoadPdfs();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ON PAGE LOAD: accept once, then load all PDFs
  // POST /api/sign/{mainDocumentId}/accept
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

      // Store all sessions returned by accept — signingSessionId per invoice
      // is preserved here and will be used as "token" in completeSign
      this.invoices = resp.signingSessions.map(session => ({
        session,
        pages:   [],
        loading: true,
        error:   null,
        signed:  false,
      }));
      this.currentPage = 0;

      // Load all PDFs in parallel
      await Promise.all(this.invoices.map((_, idx) => this.loadInvoicePdf(idx)));

    } catch (error: unknown) {
      console.error('[acceptAndLoadPdfs]', error);

      const httpError = error as any;

      if (httpError?.status === 400 || httpError?.status === 401) {
        this.showError(
          'Cette session a expiré. Veuillez relancer le processus de signature.',
          'Session expirée'
        );
      } else if (httpError?.status === 404) {
        this.showError(
          "Le lien de signature est invalide ou n'existe plus.",
          'Lien invalide'
        );
      } else {
        const msg = this.extractServerMessage(error) ?? 'Impossible de charger les factures.';
        this.showError(msg);
      }
    } finally {
      this.isLoading = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Load PDF for one invoice
  // GET /sign/{mainDocumentId}/invoices/{invoiceId}/pdf
  // ─────────────────────────────────────────────────────────────────────────

  private async loadInvoicePdf(index: number): Promise<void> {
    const inv               = this.invoices[index];
    const { invoiceId }     = inv.session;
    const pdfUrl            = `${API_BASE}/sign/${this.mainDocumentId}/invoices/${invoiceId}/pdf`;
    let   objectUrl: string | null = null;

    try {
      const pdfBlob = await firstValueFrom(
        this.http.get(pdfUrl, { responseType: 'blob' }).pipe(takeUntil(this.destroy$))
      );

      objectUrl      = URL.createObjectURL(pdfBlob);
      const pdf      = await pdfjsLib.getDocument(objectUrl).promise;
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
  // Certificate type change
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
        Swal.fire({
          icon: 'warning', title: 'Aucun certificat',
          text: "Aucun certificat valide n'a été trouvé sur ce poste.",
          confirmButtonText: 'OK',
        });
        return;
      }
      this.certificates = Array.isArray(res) ? res : [];
    } catch (error: unknown) {
      this.certificates = [];
      const httpError = error as { status?: number };
      if (httpError?.status === 0) {
        Swal.fire({
          icon: 'error', title: 'Agent PROSign non détecté',
          text: "Veuillez lancer l'application PROSign Agent sur votre ordinateur, puis réessayer.",
          confirmButtonText: 'OK',
        });
      } else {
        Swal.fire({
          icon: 'warning', title: 'Clé USB non détectée',
          text: 'Veuillez insérer votre clé USB contenant un certificat valide.',
          confirmButtonText: 'OK',
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SIGN BUTTON CLICK
  // For each invoice: prepare → agent sign → complete
  //
  // Data chain:
  //   ACCEPT response
  //     └─ session.signingSessionId ──► prepareSign body  (alias, signingSessionId, serialNumber)
  //                                         └─ prepareResp.digest ──► signViaAgent body (digest, algorithm, alias)
  //                                                                        └─ agentResp.signatureValue  ┐
  //                                                                        └─ agentResp.certificate     ├──► completeSign body
  //                                     session.signingSessionId as "token" ────────────────────────────┘
  // ─────────────────────────────────────────────────────────────────────────

  async signWithCert(cert: SscdCertificate): Promise<void> {

    if (!this.termsAccepted) {
      Swal.fire({
        icon: 'warning', title: 'Attention',
        text: 'Veuillez accepter les termes avant de signer.',
        confirmButtonText: 'OK',
      });
      return;
    }

    if (this.isSigning || this.invoices.length === 0) return;
    this.isSigning = true;

    const total   = this.invoices.length;
    const failed: string[] = [];

    try {
      // ── Agent / certificate check ────────────────────────────────────────
      this.showLoading('Vérification du certificat...');
      const isValid = await this.authPdf.verifyAgentAndCertificate();
      if (!isValid) {
        this.isSigning = false;
        Swal.close();
        return;
      }

      // ── Loop: sign each invoice sequentially ─────────────────────────────
      for (let i = 0; i < this.invoices.length; i++) {
        const inv = this.invoices[i];
        const { invoiceId, documentIdentifier } = inv.session;

        this.currentPage     = i;
        this.signingProgress = { current: i + 1, total, docId: documentIdentifier, invoiceId };

        try {
          // ── Step 1: Prepare ─────────────────────────────────────────────
          // Send: alias (cert), signingSessionId (from accept), serialNumber (cert)
          // Receive: digest (used in step 2)
          this.updateLoading(
            `Facture ${i + 1}/${total} — ${documentIdentifier} (N°${invoiceId})\nPréparation…`
          );
          const prepareResp = await this.prepareSign(inv.session, cert);
          inv.prepareResp   = prepareResp; // store for reference / debugging

          // ── Step 2: Agent local sign ────────────────────────────────────
          // Send: digest (from prepare), algorithm (cert), alias (cert)
          // Receive: signatureValue + certificate (used in step 3)
          this.updateLoading(
            `Facture ${i + 1}/${total} — ${documentIdentifier} (N°${invoiceId})\nSignature locale…`
          );
          const agentResp = await this.signViaAgent(prepareResp.digest, cert);
          inv.agentResp   = agentResp; // store for reference / debugging

          // ── Step 3: Complete ────────────────────────────────────────────
          // Send: token (signingSessionId from accept), signatureValue + certificate (from agent), algorithm (cert)
          this.updateLoading(
            `Facture ${i + 1}/${total} — ${documentIdentifier} (N°${invoiceId})\nFinalisation…`
          );
          await this.completeSign(inv.session, agentResp, cert);

          inv.signed = true;

        } catch (err: unknown) {
          console.error(`[signWithCert] invoice ${invoiceId}`, err);
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
  // Step 1 — Prepare
  // POST /api/sign/{documentIdentifier}/prepare
  //
  // Request body:
  //   {
  //     "alias":            "Mouheb ben dahmen",          ← from selected cert
  //     "signingSessionId": "cf25d5b9-73fb-427e-...",    ← from accept response
  //     "serialNumber":     "51255aefsdg22gg5666"         ← from selected cert
  //   }
  //
  // Response used: prepareResp.digest → passed to signViaAgent
  // ─────────────────────────────────────────────────────────────────────────

  private async prepareSign(
    session: InvoiceSession,
    cert:    SscdCertificate
  ): Promise<PrepareSignResponse> {
const url = `${API_BASE}/api/sign/${this.mainDocumentId}/prepare`;

    const payload = {
      alias:            cert.alias,
      signingSessionId: session.signingSessionId, // from accept
      serialNumber:     cert.serialNumber,
    };

    try {
      const response = await firstValueFrom(
        this.http.post<PrepareSignResponse>(url, payload, { headers: this.jsonHeaders() })
      );
      if (!response?.digest) {
        throw new Error('Digest absent de la réponse de préparation.');
      }
      return response;
    } catch (error: unknown) {
      const msg = this.extractServerMessage(error);
      throw new Error(msg ?? `Échec de la préparation pour la facture ${session.invoiceId}.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2 — Agent local sign
  // POST http://localhost:53821/api/certificates/signe
  //
  // Request body:
  //   {
  //     "digest":    "...",           ← from prepareSign response
  //     "algorithm": "SHA1WithRSA",  ← from selected cert
  //     "alias":     "Mouheb ben dahmen" ← from selected cert
  //   }
  //
  // Response used: agentResp.signatureValue + agentResp.certificate → passed to completeSign
  // ─────────────────────────────────────────────────────────────────────────

  private async signViaAgent(
    digest: string,
    cert:   SscdCertificate
  ): Promise<AgentSignResponse> {
    const payload = {
      digest:    digest,       // from prepareSign
      algorithm: cert.algorithm,
      alias:     cert.alias,
    };

    try {
      const response = await firstValueFrom(
        this.http.post<AgentSignResponse>(
          `${AGENT_BASE}/api/certificates/signe`,
          payload,
          { headers: this.jsonHeaders() }
        )
      );
      if (!response?.signatureValue || !response?.certificate) {
        throw new Error("Réponse de l'agent invalide.");
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof Error) throw error;
      const httpError = error as { status?: number };
      if (httpError?.status === 0) {
        throw new Error("L'agent PROSign n'est plus accessible.");
      }
      throw new Error("Échec de la signature via l'agent local.");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3 — Complete
  // POST https://api.prosign-lis.com/api/signature/complete
  //
  // Request body:
  //   {
  //     "token":          "cf25d5b9-73fb-427e-...",  ← signingSessionId from ACCEPT (not prepare)
  //     "signatureValue": "dGVzdF9zaWdu...",          ← from agent response
  //     "certificate":    "LS0tLS1CRUdJ...",          ← from agent response
  //     "algorithm":      "SHA1WithRSA"               ← from selected cert
  //   }
  // ─────────────────────────────────────────────────────────────────────────

  private async completeSign(
    session:   InvoiceSession,
    agentResp: AgentSignResponse,
    cert:      SscdCertificate
  ): Promise<void> {
    // NOTE: endpoint is /api/signature/complete (not /api/sign/.../complete)
const url = `${API_BASE}/api/sign/${this.mainDocumentId}/complete`;

const payload = {
  signingSessionId: session.signingSessionId,
  signatureValue:   agentResp.signatureValue,
  certificate:      agentResp.certificate,
  algorithm:        cert.algorithm,
};

    try {
      await firstValueFrom(
        this.http.post(url, payload, { headers: this.jsonHeaders() })
      );
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
    Swal.fire({
      title: 'Traitement en cours…', text,
      allowOutsideClick: false, allowEscapeKey: false,
      didOpen: () => Swal.showLoading(),
    });
  }

  private updateLoading(text: string): void {
    Swal.update({ text });
  }

  private showError(text: string, title = 'Erreur'): void {
    Swal.fire({ icon: 'error', title, text, confirmButtonText: 'OK' });
  }

  private extractServerMessage(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const e = error as { error?: { message?: string }; message?: string };
    return e?.error?.message ?? e?.message ?? null;
  }
}