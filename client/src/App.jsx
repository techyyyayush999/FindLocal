import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireRole } from './components/RequireRole'
import { CustomerShell } from './layouts/CustomerShell'
import { AccountPage } from './pages/AccountPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { MyReservationsPage } from './pages/MyReservationsPage'
import { NearbyPage } from './pages/NearbyPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { RegisterPage } from './pages/RegisterPage'
import { SearchPage } from './pages/SearchPage'
import { ShopDetailPage } from './pages/ShopDetailPage'
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage'
import { AdminProductsPage } from './pages/admin/AdminProductsPage'
import { AdminShopsPage } from './pages/admin/AdminShopsPage'
import { AdminUsersPage } from './pages/admin/AdminUsersPage'
import { SellerDashboardPage } from './pages/seller/SellerDashboardPage'
import { SellerInventoryPage } from './pages/seller/SellerInventoryPage'
import { SellerProductsPage } from './pages/seller/SellerProductsPage'
import { SellerReservationsPage } from './pages/seller/SellerReservationsPage'
import { SellerShopPage } from './pages/seller/SellerShopPage'

export default function App() {
  return (
    <Routes>
      <Route element={<CustomerShell />}>
        {/* ── Customer ─────────────────────────────────────────────── */}
        <Route index element={<HomePage />} />
        <Route path="nearby" element={<NearbyPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="shops/:id" element={<ShopDetailPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="home" element={<Navigate to="/" replace />} />

        {/* ── Customer (guarded) ───────────────────────────────────── */}
        <Route element={<RequireRole allow={['customer']} />}>
          <Route path="reservations" element={<MyReservationsPage />} />
        </Route>

        {/* ── Seller (guarded) ─────────────────────────────────────── */}
        <Route element={<RequireRole allow={['seller']} />}>
          <Route path="seller" element={<SellerDashboardPage />} />
          <Route path="seller/shop" element={<SellerShopPage />} />
          <Route path="seller/inventory" element={<SellerInventoryPage />} />
          <Route path="seller/products" element={<SellerProductsPage />} />
          <Route path="seller/reservations" element={<SellerReservationsPage />} />
        </Route>

        {/* ── Admin (guarded) ──────────────────────────────────────── */}
        <Route element={<RequireRole allow={['admin']} />}>
          <Route path="admin" element={<AdminDashboardPage />} />
          <Route path="admin/shops" element={<AdminShopsPage />} />
          <Route path="admin/products" element={<AdminProductsPage />} />
          <Route path="admin/users" element={<AdminUsersPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
