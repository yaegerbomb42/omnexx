    function covers(later: Record<string, unknown>, earlier: Record<string, unknown>): boolean {
      if (field(later, 'path') !== field(earlier, 'path')) return false;
      
      const ls = lineOf(later, 'start');
      const le = lineOf(later, 'end');
      const es = lineOf(earlier, 'start');
      const ee = lineOf(earlier, 'end');
      
      // If later is whole file, it covers everything
      if (ls === undefined && le === undefined) return true;
      
      // If earlier is whole file, only a whole file later read covers it
      if (es === undefined && ee === undefined) return false; // unless later is also whole file, handled above
      
      // Effective ranges (1-indexed)
      // If start is undefined, assume 1. If end is undefined, assume Infinity.
      const laterStart = ls ?? 1;
      const laterEnd = le ?? Infinity;
      const earlierStart = es ?? 1;
      const earlierEnd = ee ?? Infinity;
      
      return laterStart <= earlierStart && laterEnd >= earlierEnd;
    }
    