import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SignViewer } from './sign-viewer';

describe('SignViewer', () => {
  let component: SignViewer;
  let fixture: ComponentFixture<SignViewer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SignViewer]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SignViewer);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
