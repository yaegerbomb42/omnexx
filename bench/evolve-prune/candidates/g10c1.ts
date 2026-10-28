    } else if (r.call.name === 'grep' || r.call.name === 'glob') {
      if (later.some((l) => l.call.name === r.call.name && sameSearchInput(l.call.input, r.call.input)))
        why = `later identical ${r.call.name}`;
    }
