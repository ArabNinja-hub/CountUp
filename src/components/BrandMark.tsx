import React from 'react';
import icon from '/brand/icon.png';

/** Keep the existing CountUp icon while displaying the application's actual name. */
export const BrandMark: React.FC = () => (
  <div className="flex items-center justify-center gap-2.5" aria-label="CountUp">
    <img src={icon} alt="" className="h-10 w-10 object-contain select-none" />
    <span className="text-xl font-black tracking-tight text-emerald-950">
      Count<span className="text-emerald-700">Up</span>
    </span>
  </div>
);
