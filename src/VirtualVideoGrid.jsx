import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useWindowVirtualizer} from '@tanstack/react-virtual';

const columnsForWidth = width => {
  if (width < 560) return 1;
  if (width < 880) return 2;
  if (width < 1180) return 3;
  return 4;
};

export function VirtualVideoGrid({items, renderItem}) {
  const containerRef = useRef(null);
  const [columns, setColumns] = useState(4);
  const [scrollMargin, setScrollMargin] = useState(0);
  const rows = useMemo(() => Array.from(
    {length: Math.ceil(items.length / columns)},
    (_, index) => items.slice(index * columns, index * columns + columns)
  ), [items, columns]);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 405,
    overscan: 3,
    scrollMargin
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const update = () => {
      setColumns(columnsForWidth(container.clientWidth));
      setScrollMargin(container.offsetTop);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    virtualizer.measure();
  }, [rows.length, columns, virtualizer]);

  return <div
    ref={containerRef}
    className="virtual-grid"
    style={{height: `${virtualizer.getTotalSize()}px`}}
  >
    {virtualizer.getVirtualItems().map(virtualRow => <div
      key={virtualRow.key}
      ref={virtualizer.measureElement}
      data-index={virtualRow.index}
      className="virtual-row"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        transform: `translateY(${virtualRow.start - scrollMargin}px)`
      }}
    >
      {rows[virtualRow.index].map(renderItem)}
    </div>)}
  </div>;
}
