import { Routes } from '@angular/router';
import { SignViewer,  } from '../app/sign-viewer/sign-viewer';


export const routes: Routes = [
  { path: 'sign/:id', component: SignViewer },
  { path: '', redirectTo: 'sign/1', pathMatch: 'full' }
];
