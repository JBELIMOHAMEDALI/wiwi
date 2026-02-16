import { TestBed } from '@angular/core/testing';

import { AuthPdf } from './auth-pdf';

describe('AuthPdf', () => {
  let service: AuthPdf;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AuthPdf);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
