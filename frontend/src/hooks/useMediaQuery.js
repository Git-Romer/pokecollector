import {useEffect, useState} from 'react'

/**
 * useMediaQuery — subscribe to a CSS media query from JS.
 *
 * Needed where a responsive choice cannot be expressed in CSS: portalled
 * content renders into document.body, so Tailwind's responsive classes on
 * the React parent never reach it.
 */
export default function useMediaQuery(query) {
    const [matches, setMatches] = useState(
        () => typeof window !== 'undefined' && window.matchMedia(query).matches
    )

    useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const list = window.matchMedia(query)
        const update = (event) => setMatches(event.matches)
        setMatches(list.matches)
        list.addEventListener('change', update)
        return () => list.removeEventListener('change', update)
    }, [query])

    return matches
}
