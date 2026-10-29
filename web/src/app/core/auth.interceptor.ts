import { HttpInterceptorFn } from '@angular/common/http';
import { sessionToken } from './api.service';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const token = sessionToken();
  if (!token) {
    return next(request);
  }
  return next(
    request.clone({
      setHeaders: { 'x-convert-sp-token': token },
    }),
  );
};
