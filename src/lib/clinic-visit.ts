import { clinicName } from '@/lib/clinic-time';

const arrivalReference = 'https://maps.app.goo.gl/15xyVp2bi89p6Lrs5?g_st=ac';

export function formatVisitLocation() {
  return `📍 *Referencia de llegada · ${clinicName()}*\nGoogle Maps (Street View)\n${arrivalReference}`;
}
