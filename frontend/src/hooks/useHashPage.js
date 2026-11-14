import { useCallback, useEffect, useState } from 'react';

export default function useHashPage(pages, defaultPage = 'dashboard') {
  const getPage = useCallback(() => {
    const hash = window.location.hash
      .replace(/^#\/?/, '')
      .split('?')[0]
      .toLowerCase();

    return pages.includes(hash) ? hash : defaultPage;
  }, [pages, defaultPage]);

  const [page, setPage] = useState(getPage);

  useEffect(() => {
    const onHashChange = () => {
      setPage(getPage());
    };

    window.addEventListener('hashchange', onHashChange);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [getPage]);

  const navigate = useCallback((nextPage) => {
    if (!pages.includes(nextPage)) return;

    if (window.location.hash !== `#${nextPage}`) {
      window.location.hash = nextPage;
    }

    setPage(nextPage);
  }, [pages]);

  return [page, navigate];
}