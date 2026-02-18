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

// ─── Constants ────────────────────────────────────────────────────────────────

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

interface AcceptDocumentResponse {
  signingSessionId: string;
}

interface PrepareSignResponse {
  digest: string;
}

interface AgentSignResponse {
  signatureValue: string;
  certificate:    string;
}

interface CompleteSignResponse {
  success:  boolean;
  message?: string;
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

  // ── RxJS cleanup ──────────────────────────────────────────────────────────
  private destroy$ = new Subject<void>();

  // ── Public state (bound in template) ──────────────────────────────────────
  pdfPages:          PdfPage[]         = [];
  pdfUrl!:           string;
  termsAccepted      = false;
  selectedCert       = '';
  documentId         = '';
  certificates:      SscdCertificate[] = [];
  expandedCertIndex: number | null     = null;
  selectedCertAlias: string | null     = null;
  signedSuccess      = false;

  // ── Private state ─────────────────────────────────────────────────────────
  private signingSessionId: string | null = null;
  private isSigning = false;

  constructor(
    private http:      HttpClient,
    private sanitizer: DomSanitizer,
    private authPdf:   AuthPdf,
    private route:     ActivatedRoute
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.documentId = this.route.snapshot.paramMap.get('id') ?? '';

    if (!this.documentId) {
      this.showError('Identifiant de document manquant.', 'Document invalide');
      return;
    }

    this.pdfUrl = `${API_BASE}/sign/${this.documentId}`;
    this.loadPdf();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── PDF Loading ───────────────────────────────────────────────────────────

  async loadPdf(): Promise<void> {
    let objectUrl: string | null = null;

    try {
      const pdfBlob = await firstValueFrom(
        this.http
          .get(this.pdfUrl, { responseType: 'blob' })
          .pipe(takeUntil(this.destroy$))
      );

      objectUrl = URL.createObjectURL(pdfBlob);
      const pdf = await pdfjsLib.getDocument(objectUrl).promise;
      const pages: PdfPage[] = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page     = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas   = document.createElement('canvas');
        const ctx      = canvas.getContext('2d');

        if (!ctx) throw new Error(`Canvas 2D context unavailable for page ${i}.`);

        canvas.width  = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: ctx, viewport }).promise;

        pages.push({
          img:        canvas.toDataURL('image/png'),
          pageNumber: i,
          totalPages: pdf.numPages,
        });
      }

      this.pdfPages = pages;

} catch (error: any) {
  console.error('[loadPdf]', error);

  let message = 'Erreur lors du chargement du PDF.';

  if (error?.error instanceof Blob) {
    try {
      const text = await error.error.text();
      const json = JSON.parse(text);
      message = json?.message || message;
    } catch {
      message = await error.error.text();
    }
  } 
  else if (error?.error?.message) {
    message = error.error.message;
  }
  this.showError(message);
}

 finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  // ── Certificate type toggle ───────────────────────────────────────────────

  onCertChange(): void {
    this.expandedCertIndex = null;
    this.certificates      = [];

    if (this.selectedCert === 'digigo') {
      this.loadCertificates();
    }
  }

  // ── Load SSCD Certificates ────────────────────────────────────────────────

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
      console.error('[loadCertificates]', error);
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
          text: 'Aucun certificat détecté. Veuillez insérer votre clé USB contenant un certificat valide.',
          confirmButtonText: 'OK',
        });
      }
    }
  }

  // ── Step 1: Accept document → signingSessionId ───────────────────────────

  private async acceptDocument(): Promise<void> {
    const url = `${API_BASE}/api/sign/${this.documentId}/accept`;

    try {
      const response = await firstValueFrom(
        this.http.post<AcceptDocumentResponse>(
          url,
          {},
          { headers: this.jsonHeaders() }
        )
      );

      if (!response?.signingSessionId) {
        throw new Error("signingSessionId absent de la réponse d'acceptation.");
      }

      this.signingSessionId = response.signingSessionId;

    } catch (error: unknown) {
      console.error('[acceptDocument]', error);
      const msg = this.extractServerMessage(error);
      throw new Error(msg ?? "Impossible d'accepter le document. Veuillez réessayer.");
    }
  }

  // ── Step 2: Prepare → digest ──────────────────────────────────────────────

  private async prepareSign(cert: SscdCertificate): Promise<string> {
    const url = `${API_BASE}/api/sign/${this.documentId}/prepare`;

    const payload = {
      alias:            cert.alias,
      serialNumber:     cert.serialNumber,
      signingSessionId: this.signingSessionId,
    };

    try {
      const response = await firstValueFrom(
        this.http.post<PrepareSignResponse>(url, payload, {
          headers: this.jsonHeaders(),
        })
      );

      if (!response?.digest) {
        throw new Error('Digest absent de la réponse de préparation.');
      }

      return response.digest;

    } catch (error: unknown) {
      console.error('[prepareSign]', error);
      const msg = this.extractServerMessage(error);
      throw new Error(msg ?? 'Échec de la préparation de la signature. Veuillez réessayer.');
    }
  }

  // ── Step 3: Sign via local agent ──────────────────────────────────────────

  private async signViaAgent(
    digest: string,
    cert:   SscdCertificate
  ): Promise<AgentSignResponse> {
    const payload = { digest, algorithm: cert.algorithm, alias: cert.alias };

    try {
      const response = await firstValueFrom(
        this.http.post<AgentSignResponse>(
          `${AGENT_BASE}/api/certificates/signe`,
          payload,
          { headers: this.jsonHeaders() }
        )
      );

      if (!response?.signatureValue || !response?.certificate) {
        throw new Error(
          "Réponse de l'agent invalide (signatureValue ou certificate manquant)."
        );
      }

      return response;

    } catch (error: unknown) {
      console.error('[signViaAgent]', error);

      if (error instanceof Error) throw error;

      const httpError = error as { status?: number };
      if (httpError?.status === 0) {
        throw new Error(
          "L'agent PROSign n'est plus accessible. Vérifiez qu'il est toujours en cours d'exécution."
        );
      }

      throw new Error("Échec de la signature via l'agent local. Veuillez réessayer.");
    }
  }

  // ── Step 4: Complete signature on server ──────────────────────────────────

  private async completeSign(
    agentResponse: AgentSignResponse,
    cert:          SscdCertificate
  ): Promise<void> {
    const url = `${API_BASE}/api/sign/${this.documentId}/complete`;

    const payload = {
      signingSessionId: this.signingSessionId,
      signatureValue:   agentResponse.signatureValue,
      certificate:      agentResponse.certificate,
      algorithm:        cert.algorithm,
    };

    try {
      const response = await firstValueFrom(
        this.http.post<CompleteSignResponse>(url, payload, {
          headers: this.jsonHeaders(),
        })
      );

      console.info('[completeSign] Serveur :', response);

    } catch (error: unknown) {
      console.error('[completeSign]', error);
      const msg = this.extractServerMessage(error);
      throw new Error(
        msg ?? 'Échec de la finalisation de la signature. Veuillez contacter le support.'
      );
    }
  }

  // ── Main signing orchestration ────────────────────────────────────────────

  async signWithCert(cert: SscdCertificate): Promise<void> {

    if (!this.termsAccepted) {
      Swal.fire({
        icon: 'warning', title: 'Attention',
        text: 'Veuillez accepter les termes avant de signer.',
        confirmButtonText: 'OK',
      });
      return;
    }

    if (this.isSigning) return;
    this.isSigning = true;

    this.showLoading('Vérification du certificat...');

    try {
      // 1 – Environment check
      const isValid = await this.authPdf.verifyAgentAndCertificate();
      if (!isValid) return;

      // 2 – Accept document, get session ID
      this.updateLoading('Acceptation du document...');
      await this.acceptDocument();

      // 3 – Server prepares digest
      this.updateLoading('Préparation de la signature...');
      const digest = await this.prepareSign(cert);

      // 4 – Local agent signs digest with private key
      this.updateLoading('Signature en cours via votre certificat...');
      const agentResponse = await this.signViaAgent(digest, cert);

      // 5 – Server finalises
      this.updateLoading('Finalisation de la signature...');
      await this.completeSign(agentResponse, cert);

      // 6 – Success: show Swal then switch to success screen
      Swal.fire({
        icon:              'success',
        title:             'Document signé !',
        text:              'Le document a été signé avec succès.',
        confirmButtonText: 'OK',
        allowOutsideClick: false,
        allowEscapeKey:    false,
      }).then((result) => {
        if (result.isConfirmed) {
          this.pdfPages        = [];
          this.termsAccepted   = false;
          this.certificates    = [];
          this.selectedCert    = '';
          this.signedSuccess   = true;
        }
      });

    } catch (error: unknown) {
      console.error('[signWithCert]', error);

      Swal.fire({
        icon:              'error',
        title:             'Erreur de signature',
        text:              error instanceof Error
          ? error.message
          : 'Une erreur inattendue est survenue lors de la signature.',
        confirmButtonText: 'OK',
      });

    } finally {
      this.isSigning = false;
    }
  }

  // ── Legacy (kept for compatibility) ──────────────────────────────────────

  signDocument(): void {
    if (!this.termsAccepted || !this.selectedCert) return;
    Swal.fire({ icon: 'info', title: 'Signature', text: 'Signature lancée !' });
  }

  // ── Template helpers ──────────────────────────────────────────────────────

  getIssuerCN(issuer: string): string {
    const match = issuer?.match(/CN=([^,]+)/);
    return match ? match[1] : issuer;
  }

  // ── Private utilities ─────────────────────────────────────────────────────

  private jsonHeaders(): HttpHeaders {
    return new HttpHeaders({ 'Content-Type': 'application/json' });
  }

  private showLoading(text: string): void {
    Swal.fire({
      title:             'Traitement en cours...',
      text,
      allowOutsideClick: false,
      allowEscapeKey:    false,
      didOpen:           () => Swal.showLoading(),
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