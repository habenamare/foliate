const webpubFromText = async uri => {
    const res = await fetch(uri)
    const data = await res.text()

    const chapters = data.split(/(\r?\n){3,}/g)
        .filter(x => !/^\r?\n$/.test(x))
        .map(c => {
            const ps = c.split(/(\r?\n){2}/g)
                .filter(x => !/^\r?\n$/.test(x))
            const doc = document.implementation.createHTMLDocument()
            ps.forEach(p => {
                const el = doc.createElement('p')
                el.textContent = p
                doc.body.appendChild(el)
            })
            const blob = new Blob(
                [doc.documentElement.outerHTML],
                { type: 'text/html' })
            const url = URL.createObjectURL(blob)
            return {
                href: url,
                type: 'text/html',
                title: ps[0].replace(/\r?\n/g, '')
            }
        })

    return {
        metadata: {},
        links: [],
        readingOrder: chapters,
        toc: chapters,
        resources: []
    }
}

const XLINK_NS = 'http://www.w3.org/1999/xlink'

const webpubFromFB2Zip = async uri => {
    let zip = new JSZip()
    const res = await fetch(uri)
    const data = await res.blob()
    zip = await JSZip.loadAsync(data)
    const text = await zip.file(/.fb2$/)[0].async('string')
    let doc = new DOMParser().parseFromString(text, 'text/xml')
    return processFB2(doc)
}

const webpubFromFB2 = async uri => {
    const res = await fetch(uri)
    const buffer = await res.arrayBuffer()
    const decoder = new TextDecoder('utf-8')
    const data = decoder.decode(buffer)
    let doc = new DOMParser().parseFromString(data, 'text/xml')
    if (doc.xmlEncoding !== 'utf-8') {
        const decoder = new TextDecoder(doc.xmlEncoding)
        const data = decoder.decode(buffer)
        doc = new DOMParser().parseFromString(data, 'text/xml')
    }
    return processFB2(doc)
}

const fb2ToHtml = (x, h, getImage) => {
    Array.from(x.querySelectorAll('title, subtitle'))
        .forEach(el => {
            const tag = el.tagName === 'title' ? 'h2' : 'h3'
            Array.from(el.querySelectorAll('p'))
                .forEach(el => { el.innerHTML = `${el.innerHTML}<br>`; usurp(el) })
            el.parentNode.replaceChild(h(`<${tag}>${el.innerHTML}</${tag}>`), el)
        })
    if (getImage) Array.from(x.querySelectorAll('image'))
        .forEach(el => {
            const src = getImage(el).data
            const alt = el.getAttribute('alt') || ''
            const title = el.getAttribute('title') || ''
            const img = h(`<img src="${src}" alt="${alt}" title="${title}">`)
            el.parentNode.replaceChild(img, el)
        })
    Array.from(x.querySelectorAll('empty-line'))
        .forEach(el => el.parentNode.replaceChild(h(`<br>`), el))
    Array.from(x.querySelectorAll('style'))
        .forEach(el => usurp(el))
    Array.from(x.querySelectorAll('emphasis'))
        .forEach(el => el.parentNode.replaceChild(h(`<em>${el.innerHTML}</em>`), el))
    Array.from(x.querySelectorAll('strikethrough'))
        .forEach(el => el.parentNode.replaceChild(h(`<s>${el.innerHTML}</s>`), el))
    Array.from(x.querySelectorAll('poem, epigraph, cite'))
        .forEach(el => el.parentNode.replaceChild(h(`<blockquote>${el.innerHTML}</blockquote>`), el))
    Array.from(x.querySelectorAll('stanza'))
        .forEach(el => el.parentNode.replaceChild(h(`<p>${el.innerHTML}</p>`), el))
    Array.from(x.querySelectorAll('text-author'))
        .forEach(el => el.parentNode.replaceChild(h(`<p class="text-author">${el.innerHTML}</p>`), el))
    Array.from(x.querySelectorAll('date'))
        .forEach(el => el.parentNode.replaceChild(h(`<p class="date">${el.innerHTML}</p>`), el))
    Array.from(x.querySelectorAll('v'))
        .forEach(el => { el.innerHTML = `${el.innerHTML}<br>`; usurp(el) })
    Array.from(x.querySelectorAll('a[type=note]'))
        .forEach(el => el.innerHTML = `<sup>${el.innerHTML}</sup>`)
    return x
}

let fb2doc // useful for debugging
const processFB2 = doc => {
    fb2doc = doc
    const $ = doc.querySelector.bind(doc)
    const $$ = doc.querySelectorAll.bind(doc)
    const h = html => {
        const el = doc.createElement('template')
        el.innerHTML = html
        return el.firstChild
    }

    const getTextContent = x => {
        const el = $(x)
        return el ? el.textContent : ''
    }
    const title = getTextContent('title-info book-title')
    const identifier = getTextContent('title-info id')
    const annotation = $('title-info annotation')
    const description = annotation ? fb2ToHtml(annotation, h).innerHTML : undefined
    const language = getTextContent('title-info lang')
    const pubdate = getTextContent('title-info date')
    const publisher = getTextContent('publish-info publisher')
    const creator = Array.from($$('title-info author')).map(x => [
        x.querySelector('first-name'),
        x.querySelector('middle-name'),
        x.querySelector('last-name')
    ].filter(x => x).map(x => x.textContent).join(' ')).join(', ')

    const getIdFromHref = href => {
        const [a, b] = href.split('#')
        return a ? null : b
    }

    const getImage = image => {
        const href = image.getAttributeNS(XLINK_NS, 'href')
        const id = getIdFromHref(href)
        const bin = doc.getElementById(id)
        if (!bin) return {}
        const type = bin.getAttribute('content-type')
        return {
            content: bin.textContent,
            data: `data:${type};base64,${bin.textContent}`,
            type
        }
    }

    try {
        const { content } = getImage($('coverpage image'))
        dispatch({ type: 'cover', payload: content })
    } catch (e) {}


    const stylesheet = `
        body > img, section > img {
            display: block;
            margin: auto;
        }
        h1 {
            text-align: center;
        }
        .text-author, .date {
            text-align: right;
        }
        .text-author:before {
            content: "—";
        }
    `
    const styleBlob = new Blob([stylesheet], { type: 'text/css' })
    const styleUrl = URL.createObjectURL(styleBlob)

    const notes = new Map()
    const sections = Array.from($$('body > *')).map(x => {
        const id = x.getAttribute('id')
        if (notes.has(id)) return notes.get(id)

        let sectionTitle = x.querySelector('title') || x.querySelector('p')
        if (x.tagName === 'image') x.innerHTML = `<img src="${getImage(x).data}">`
        if (x.tagName === 'title') {
            sectionTitle = x
            Array.from(x.querySelectorAll('p'))
                .forEach(el => el.parentNode.replaceChild(h(`<h1>${el.textContent}</h1>`), el))
        }

        Array.from(x.querySelectorAll('a'))
            .forEach(el => {
                const href = el.getAttributeNS(XLINK_NS, 'href')
                if (href) {
                    const id = getIdFromHref(href)
                    if (!id) return el.setAttribute('href', href)
                    const note = doc.getElementById(id)
                    let sectionTitle = note.querySelector('title')
                    fb2ToHtml(note, h, getImage)
                    const html = `<!DOCTYPE html>
                        <link href="${styleUrl}" rel="stylesheet">
                        <section id="${id}">
                            ${note.innerHTML}
                        </section>`
                    if (notes.has(id)) {
                        el.setAttribute('href', notes.get(id).href + '#' + id)
                    } else {
                        const blob = new Blob([html], { type: 'text/html' })
                        const url = URL.createObjectURL(blob)
                        const item = {
                            href: url,
                            type: 'text/html',
                            title: (sectionTitle ? sectionTitle.textContent : title)
                        }
                        notes.set(id, item)
                        el.setAttribute('href', url + '#' + id)
                    }
                }
            })

        fb2ToHtml(x, h, getImage)
        const html = `<!DOCTYPE html>
            <link href="${styleUrl}" rel="stylesheet">
            ${x.innerHTML}`
        const blob = new Blob([html], { type: 'text/html' })
        const url = URL.createObjectURL(blob)

        return {
            href: url,
            type: 'text/html',
            title: (sectionTitle ? sectionTitle.textContent : title)
                .trim().replace(/\r?\n/g, ' ')
        }
    })

    return {
        metadata: {
            title,
            creator,
            identifier,
            description,
            language,
            pubdate,
            publisher
        },
        links: [],
        readingOrder: sections,
        toc: sections,
        resources: [
            { href: styleUrl, type: 'text/css' }
        ]
    }
}

const webpubFromComicBookArchive = async (uri, inputType, layout) => {
    const cbArchiveName = decodeURI(uri).split('/').pop().split('.').slice(0, -1).join('')

    const automaticStylesheet = () => {
        return `
            * {
                margin: 0 !important;
                padding: 0 !important;
            }

            body {
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .image-wrapper {
                display: flex;
                align-items: center;
                justify-content: center;

                min-height: 99.5vh;
            }

            .image-wrapper img {
                width: 99vw;
                max-height: 99.5vh;
                object-fit: contain;
            }
        `
    }

    const fitPageStylesheet = () => {
        return `
            * {
                margin: 0 !important;
                padding: 0 !important;
            }

            body {
                display: flex;
                align-items: center;
                justify-content: center;
            }
        `
    }
    
    const fitWidthStylesheet = () => {
        return `
            * {
                margin: 0 !important;
                padding: 0 !important;
            }

            body {
                text-align: center;
            }

            .image-wrapper img {
                width: 100%;
            }
        `
    }
    
    const continuousStylesheet = () => {
        return `
            * {
                margin: 0 !important;
                padding: 0 !important;
            }

            body {
                text-align: center;
                margin-bottom: 20px !important;
            }

            .image-wrapper img {
                width: 100%;
            }
        `
    }
    
    const fitPageScripts = async () => { return `` }
    const fitWidthScripts = async () => { return `` }
    const continuousScripts = async () => { return `` }
    const automaticScripts = async () => { return `` }

    let stylesheet;
    let scripts;
    switch (layout) {
        case 'automatic': {
            stylesheet = automaticStylesheet()
            scripts = await automaticScripts()
            break
        }
        case 'single-column': {
            stylesheet = fitPageStylesheet()
            scripts = await fitPageScripts()
            break
        }
        case 'scrolled': {
            stylesheet = fitWidthStylesheet()
            scripts = await fitWidthScripts()
            break
        }
        case 'continuous': {
            stylesheet = continuousStylesheet()
            scripts = await continuousScripts()
            break
        }
        default: {
            stylesheet = fitPageStylesheet()
            scripts = await fitPageScripts()
            console.log('unexpected layout')
        }
    }

    const stylesheetBlob = new Blob([stylesheet], { type: 'text/css' })
    const stylesheetURL = URL.createObjectURL(stylesheetBlob)

    let files
    switch (inputType) {
        case 'cbz': files = await unpackZipArchive(uri); break
        case 'cbr': files = await unpackArchive(uri, inputType); break
        case 'cb7': files = await unpackArchive(uri, inputType); break
        case 'cbt': files = await unpackArchive(uri, inputType); break
    }

    const sectionLinkObjects = files.filter(file =>
            ['jpeg', 'png', 'gif', 'bmp', 'webp'].includes(file.type))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(image => {
            const html = `
            <!doctype html>
            <html>
                <head>
                    <title>${image.name}</title>
                    <link rel="stylesheet" type="text/css" href="${stylesheetURL}" />
                </head>

                <body>
                    <section class="image-wrapper">
                        <img src="${URL.createObjectURL(image.blob)}" alt="${image.name}" />
                    </section>

                    <!-- SCRIPTS -->
                    ${scripts}
                </body>
            </html>
            `

            const pageHTMLBlob = new Blob([html], { type: 'text/html' })
            const pageURL = URL.createObjectURL(pageHTMLBlob)

            return {
                href: pageURL,
                type: 'text/html',
                title: image.name
            }
        })

    return {
        metadata: {
            title: cbArchiveName,
            layout: layout === 'automatic' ? 'pre-paginated' : 'reflowable'
        },
        links: [],
        readingOrder: sectionLinkObjects,
        toc: sectionLinkObjects,
        resources: []
    }
}
