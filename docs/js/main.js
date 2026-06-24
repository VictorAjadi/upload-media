/**
 * UploadMedia Documentation Main Script
 * Handles navigation, code copying, and scroll spying.
 */

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // 2. Multi-page Active Link Handling
    const currentPath = window.location.pathname.split('/').pop() || 'index.html';
    const navLinks = document.querySelectorAll('.sidebar-link');

    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPath) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    const sections = document.querySelectorAll('section[id]');
    const scrollSpy = () => {
        const fromTop = window.scrollY + 100;

        sections.forEach(section => {
            if (
                section.offsetTop <= fromTop &&
                section.offsetTop + section.offsetHeight > fromTop
            ) {
                navLinks.forEach(link => {
                    link.classList.remove('active');
                    if (link.getAttribute('href') === `#${section.id}`) {
                        link.classList.add('active');
                    }
                });
            }
        });
    };

    window.addEventListener('scroll', scrollSpy);
    scrollSpy(); // Run once on load

    // 3. Smooth Scrolling for Sidebar Links
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            
            // Only hijack if it's a hash link on the CURRENT page
            if (href.startsWith('#')) {
                e.preventDefault();
                const targetEntry = document.querySelector(href);
                
                if (targetEntry) {
                    window.scrollTo({
                        top: targetEntry.offsetTop - 80,
                        behavior: 'smooth'
                    });
                }
            }
            // If it's a file link (index.html, server.html), let the browser handle it.
        });
    });

    // 4. Code Block Copy Logic
    const codeBlocks = document.querySelectorAll('.code-container');
    codeBlocks.forEach(block => {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn text-xs hover:text-white transition-colors';
        copyBtn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i>';
        
        const header = block.querySelector('.code-header');
        if (header) {
            header.appendChild(copyBtn);
        }

        copyBtn.addEventListener('click', async () => {
            const code = block.querySelector('pre');
            if (code) {
                await navigator.clipboard.writeText(code.innerText);
                copyBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-green-500"></i>';
                setTimeout(() => {
                    copyBtn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i>';
                    lucide.createIcons();
                }, 2000);
            }
        });
    });

    // 5. Reactive Search (Simple Client-Side)
    const searchInput = document.getElementById('docs-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const navItems = document.querySelectorAll('.sidebar-nav-item');
            
            navItems.forEach(item => {
                const text = item.innerText.toLowerCase();
                if (text.includes(query)) {
                    item.style.display = 'block';
                } else {
                    item.style.display = 'none';
                }
            });
        });
    }

    // 6. Intersection Observer for Animations
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('reveal-active');
                revealObserver.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
});
