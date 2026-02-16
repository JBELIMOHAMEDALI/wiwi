import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { firstValueFrom } from 'rxjs';
import Swal from 'sweetalert2';

@Injectable({
  providedIn: 'root'
})
export class AuthPdf {


  constructor(private http: HttpClient) {}

async getToken(): Promise<string> {

  const body = new URLSearchParams();
  body.set('client_id', environment.authCredentials.client_id);
  body.set('username', environment.authCredentials.username);
  body.set('password', environment.authCredentials.password);
  body.set('grant_type', environment.authCredentials.grant_type);
  body.set('scope', environment.authCredentials.scope);
  body.set('client_secret', environment.authCredentials.client_secret);

  const response: any = await firstValueFrom(
    this.http.post(
      environment.authUrl,
      body.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    )
  );

  return response.access_token;
}

async verifyAgentAndCertificate(): Promise<boolean> {
  try {

    const res: any = await firstValueFrom(
      this.http.get('http://localhost:53821/api/certificates')
    );

    // Agent running but no certificate
    if (!res || res.success === false || res.length === 0) {

      Swal.fire({
        icon: 'warning',
        title: 'Clé USB non détectée',
        text: 'Aucun certificat détecté. Veuillez insérer votre clé USB contenant un certificat valide.',
        confirmButtonText: 'OK'
      });

      return false;
    }

    return true;

  } catch (error: any) {

    // Agent not running (connection refused)
    if (error.status === 0) {

      Swal.fire({
        icon: 'error',
        title: 'Agent PROSign non détecté',
        text: 'Veuillez lancer l’application PROSign Agent sur votre ordinateur, puis réessayer.',
        confirmButtonText: 'OK'
      });

    } else {

        Swal.fire({
          icon: 'warning',
          title: 'Clé USB non détectée',
          text: 'Aucun certificat détecté. Veuillez insérer votre clé USB contenant un certificat valide.',
          confirmButtonText: 'OK'
        });
    }

    return false;
  }
}

}
